import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getAllFilteredCompanies, type CompanyListFilters } from "@/lib/data/companies";

export const CLAY_CONCURRENCY = 8;
export const IN_CHUNK = 200;
export const WEBHOOK_RETRIES = 1;
export const FAILED_PREVIEW = 20;

/** 429s get their own retry budget, separate from WEBHOOK_RETRIES (which
 * covers 5xx/network blips): concurrency fires 8 requests at once, so a
 * short burst tripping Clay's rate limit is expected, not exceptional. A
 * single flat 250ms retry isn't enough to clear it — this backs off
 * exponentially (honoring `Retry-After` when Clay sends one) instead of
 * lowering CLAY_CONCURRENCY, so the push doesn't get slower for the common
 * case of a request that never gets rate-limited. */
export const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_BASE_DELAY_MS = 500;
const RATE_LIMIT_MAX_DELAY_MS = 8_000;

export interface ClayPushProgress {
  phase: "resolving" | "pushing" | "done";
  done: number;
  total: number;
  pushed: number;
  errors: number;
}

export interface ClayPushResult {
  total_matched: number;
  pushed: number;
  errors: number;
  failed_companies: string[];
}

export interface RunClayPushDeps {
  fetchImpl?: typeof fetch;
  onProgress?: (p: ClayPushProgress) => void;
}

/** The webhook target is supplied per-push from the UI (not from env), so it
 * must be validated before we ever POST to it. Require a well-formed https URL
 * — this is the minimal guard against the server being pointed at an
 * arbitrary/internal target. */
export function isValidWebhookUrl(url: unknown): url is string {
  if (typeof url !== "string" || url.trim() === "") return false;
  try {
    return new URL(url).protocol === "https:";
  } catch {
    return false;
  }
}

const PAYLOAD_COLUMNS =
  "id,company_name,domain,website_url,linkedin_url,industry,city,state,country,employee_count,phone,description,founded_year,revenue,source,quality_tier,mx_provider,security_gateway,keywords,technologies";

interface CompanyRow {
  id: string;
  company_name: string | null;
  domain: string | null;
  website_url: string | null;
  linkedin_url: string | null;
  industry: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  employee_count: number | null;
  phone: string | null;
  description: string | null;
  founded_year: number | null;
  revenue: number | null;
  source: string | null;
  quality_tier: string | null;
  mx_provider: string | null;
  security_gateway: string | null;
  keywords: string[] | null;
  technologies: string[] | null;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Fetch full payload rows for the matched ids. Unlike the earlier version,
 * this no longer filters on `pushed_to_clay` — every company in the current
 * filter is pushed on every run, duplicates included (Clay dedupes its side). */
async function fetchMatchedRows(matchedIds: string[]): Promise<CompanyRow[]> {
  const rows: CompanyRow[] = [];
  for (const idChunk of chunk(matchedIds, IN_CHUNK)) {
    const { data, error } = await supabaseAdmin
      .from("companies")
      .select(PAYLOAD_COLUMNS)
      .in("id", idChunk);
    if (error) throw error;
    if (data) rows.push(...(data as unknown as CompanyRow[]));
  }
  return rows;
}

function toWebhookPayload(row: CompanyRow) {
  return {
    company_id: row.id,
    company_name: row.company_name,
    domain: row.domain,
    website_url: row.website_url,
    linkedin_url: row.linkedin_url,
    industry: row.industry,
    city: row.city,
    state: row.state,
    country: row.country,
    employee_count: row.employee_count,
    phone: row.phone,
    description: row.description,
    founded_year: row.founded_year,
    revenue: row.revenue,
    source: row.source,
    quality_tier: row.quality_tier,
    mx_provider: row.mx_provider,
    security_gateway: row.security_gateway,
    keywords: row.keywords,
    technologies: row.technologies,
  };
}

const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);

interface PostResult {
  ok: boolean;
  status?: number;
  error?: string;
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

function rateLimitBackoffMs(attempt: number): number {
  const exp = Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt, RATE_LIMIT_MAX_DELAY_MS);
  return exp + Math.random() * 250; // jitter so a burst doesn't retry in lockstep
}

async function postWithRetry(
  fetchImpl: typeof fetch,
  webhookUrl: string,
  row: CompanyRow
): Promise<PostResult> {
  const body = JSON.stringify(toWebhookPayload(row));
  let transientAttempt = 0;
  let rateLimitAttempt = 0;

  for (;;) {
    try {
      const resp = await fetchImpl(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
      if (resp.ok) return { ok: true };

      if (resp.status === 429) {
        if (rateLimitAttempt >= RATE_LIMIT_MAX_RETRIES) return { ok: false, status: 429 };
        const retryAfterMs = parseRetryAfterMs(resp.headers?.get?.("Retry-After") ?? null);
        await new Promise((r) => setTimeout(r, retryAfterMs ?? rateLimitBackoffMs(rateLimitAttempt)));
        rateLimitAttempt++;
        continue;
      }

      if (!TRANSIENT_STATUSES.has(resp.status)) return { ok: false, status: resp.status };
      if (transientAttempt >= WEBHOOK_RETRIES) return { ok: false, status: resp.status };
      await new Promise((r) => setTimeout(r, 250));
      transientAttempt++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (transientAttempt >= WEBHOOK_RETRIES) return { ok: false, error: message };
      await new Promise((r) => setTimeout(r, 250));
      transientAttempt++;
    }
  }
}

interface FailedCompanyDetail {
  company_id: string;
  company_name: string | null;
  status: number | null;
  error: string | null;
}

/** Best-effort persistence — logging must never take down the push itself
 * (e.g. the migration hasn't been run yet in this environment). */
async function logRunStart(webhookUrl: string, filters: CompanyListFilters): Promise<string | null> {
  try {
    const webhookHost = new URL(webhookUrl).host;
    const { data, error } = await supabaseAdmin
      .from("clay_push_runs")
      .insert({ webhook_host: webhookHost, filters })
      .select("id")
      .single();
    if (error) throw error;
    return data.id as string;
  } catch (err) {
    console.error("Clay push: failed to log run start", err);
    return null;
  }
}

async function logRunEnd(
  runId: string | null,
  update: {
    status: "done" | "failed";
    total_matched?: number;
    pushed_count?: number;
    error_count?: number;
    failed_companies?: FailedCompanyDetail[];
    error_message?: string;
  }
): Promise<void> {
  if (!runId) return;
  try {
    const { error } = await supabaseAdmin
      .from("clay_push_runs")
      .update({ ...update, completed_at: new Date().toISOString() })
      .eq("id", runId);
    if (error) throw error;
  } catch (err) {
    console.error("Clay push: failed to log run end", err);
  }
}

/** Push every company in the current filtered view to `webhookUrl`.
 *
 * The webhook target is passed in per-call from the UI. Filter resolution
 * reuses `getAllFilteredCompanies` (the same path CSV export uses) so the
 * pushed set always equals the on-screen set. No skip-already-pushed and no
 * `pushed_to_clay` marking: every matching company is sent on every run. */
export async function runClayPush(
  filters: CompanyListFilters,
  webhookUrl: string,
  deps: RunClayPushDeps = {}
): Promise<ClayPushResult> {
  if (!isValidWebhookUrl(webhookUrl)) {
    throw new Error("A valid https webhook URL is required");
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const onProgress = deps.onProgress;

  const runId = await logRunStart(webhookUrl, filters);

  try {
    onProgress?.({ phase: "resolving", done: 0, total: 0, pushed: 0, errors: 0 });

    const matched = await getAllFilteredCompanies(filters);
    const total_matched = matched.length;

    if (total_matched === 0) {
      onProgress?.({ phase: "done", done: 0, total: 0, pushed: 0, errors: 0 });
      await logRunEnd(runId, {
        status: "done",
        total_matched: 0,
        pushed_count: 0,
        error_count: 0,
        failed_companies: [],
      });
      return { total_matched: 0, pushed: 0, errors: 0, failed_companies: [] };
    }

    const rows = await fetchMatchedRows(matched.map((c) => c.id));

    onProgress?.({ phase: "pushing", done: 0, total: rows.length, pushed: 0, errors: 0 });

    let pushed = 0;
    let errors = 0;
    let done = 0;
    const failed_companies: string[] = [];
    const failed_details: FailedCompanyDetail[] = [];

    for (const group of chunk(rows, CLAY_CONCURRENCY)) {
      const results = await Promise.allSettled(
        group.map(async (row) => ({
          row,
          result: await postWithRetry(fetchImpl, webhookUrl, row),
        }))
      );

      for (const settled of results) {
        done++;
        if (settled.status === "fulfilled" && settled.value.result.ok) {
          pushed++;
        } else {
          errors++;
          const row = settled.status === "fulfilled" ? settled.value.row : null;
          const result = settled.status === "fulfilled" ? settled.value.result : null;
          const name = row?.company_name ?? null;
          if (failed_companies.length < FAILED_PREVIEW) {
            failed_companies.push(name || "unknown");
          }
          failed_details.push({
            company_id: row?.id ?? "unknown",
            company_name: name,
            status: result?.status ?? null,
            error:
              result?.error ??
              (settled.status === "rejected"
                ? String((settled as PromiseRejectedResult).reason)
                : null),
          });
        }
      }

      onProgress?.({ phase: "pushing", done, total: rows.length, pushed, errors });
    }

    onProgress?.({ phase: "done", done, total: rows.length, pushed, errors });

    await logRunEnd(runId, {
      status: "done",
      total_matched,
      pushed_count: pushed,
      error_count: errors,
      failed_companies: failed_details,
    });

    return { total_matched, pushed, errors, failed_companies };
  } catch (err) {
    await logRunEnd(runId, {
      status: "failed",
      error_message: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
