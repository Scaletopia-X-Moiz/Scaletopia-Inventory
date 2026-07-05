import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getCompaniesForClay, type CompanyListFilters } from "@/lib/data/companies";
import { getPeopleForClay, type PersonListFilters } from "@/lib/data/people";
import type { ClayPushRecord } from "@/lib/clay/types";

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
export const RATE_LIMIT_MAX_DELAY_MS = 8_000;

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
  /** Preview of failed record display names (company/person), capped at FAILED_PREVIEW. */
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

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
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

/** Exported for tests: exercises the 429/transient retry logic in isolation
 * (no DB round-trip), so the `Retry-After` clamp can be asserted directly. */
export async function postWithRetry(
  fetchImpl: typeof fetch,
  webhookUrl: string,
  payload: Record<string, unknown>
): Promise<PostResult> {
  const body = JSON.stringify(payload);
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
        // Clamp the honored `Retry-After` to RATE_LIMIT_MAX_DELAY_MS. This runs
        // inside a serverless invocation, so a hostile or misconfigured Clay
        // endpoint returning a far-future date (or a huge seconds value) would
        // otherwise block the whole push — and the user's SSE progress stream —
        // until `maxDuration` kills it. A null/negative parse still falls
        // through to the exponential backoff below.
        const delayMs =
          retryAfterMs != null
            ? Math.min(retryAfterMs, RATE_LIMIT_MAX_DELAY_MS)
            : rateLimitBackoffMs(rateLimitAttempt);
        await new Promise((r) => setTimeout(r, delayMs));
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

interface FailedRecordDetail {
  id: string;
  name: string | null;
  status: number | null;
  error: string | null;
}

/** Best-effort persistence — logging must never take down the push itself
 * (e.g. the migration hasn't been run yet in this environment). */
async function logRunStart(
  entity: string,
  webhookUrl: string,
  filters: unknown
): Promise<string | null> {
  try {
    const webhookHost = new URL(webhookUrl).host;
    const { data, error } = await supabaseAdmin
      .from("clay_push_runs")
      .insert({ webhook_host: webhookHost, filters: { entity, ...(filters as object) } })
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
    failed_companies?: FailedRecordDetail[];
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

interface ClayEntity<TFilters> {
  /** Discriminates run-log rows (companies vs people). */
  label: string;
  /** Resolves the current filtered view into full webhook payloads. */
  loadRecords: (filters: TFilters) => Promise<ClayPushRecord[]>;
}

/** Push every record in the current filtered view to `webhookUrl`.
 *
 * The webhook target is passed in per-call from the UI. Record resolution runs
 * through the same filtered query the list/export use, so the pushed set always
 * equals the on-screen set. No skip-already-pushed and no `pushed_to_clay`
 * marking: every matching record is sent on every run (Clay dedupes its side).
 * Each payload carries the full record — every native column plus all
 * enrichment (custom_data) keys flattened to the top level. */
async function runClayPush<TFilters>(
  entity: ClayEntity<TFilters>,
  filters: TFilters,
  webhookUrl: string,
  deps: RunClayPushDeps = {}
): Promise<ClayPushResult> {
  if (!isValidWebhookUrl(webhookUrl)) {
    throw new Error("A valid https webhook URL is required");
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const onProgress = deps.onProgress;

  const runId = await logRunStart(entity.label, webhookUrl, filters);

  try {
    onProgress?.({ phase: "resolving", done: 0, total: 0, pushed: 0, errors: 0 });

    const records = await entity.loadRecords(filters);
    const total_matched = records.length;

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

    onProgress?.({ phase: "pushing", done: 0, total: records.length, pushed: 0, errors: 0 });

    let pushed = 0;
    let errors = 0;
    let done = 0;
    const failed_companies: string[] = [];
    const failed_details: FailedRecordDetail[] = [];

    for (const group of chunk(records, CLAY_CONCURRENCY)) {
      const results = await Promise.allSettled(
        group.map(async (record) => ({
          record,
          result: await postWithRetry(fetchImpl, webhookUrl, record.payload),
        }))
      );

      for (const settled of results) {
        done++;
        if (settled.status === "fulfilled" && settled.value.result.ok) {
          pushed++;
        } else {
          errors++;
          const record = settled.status === "fulfilled" ? settled.value.record : null;
          const result = settled.status === "fulfilled" ? settled.value.result : null;
          const name = record?.displayName ?? null;
          if (failed_companies.length < FAILED_PREVIEW) {
            failed_companies.push(name || "unknown");
          }
          failed_details.push({
            id: record?.id ?? "unknown",
            name,
            status: result?.status ?? null,
            error:
              result?.error ??
              (settled.status === "rejected"
                ? String((settled as PromiseRejectedResult).reason)
                : null),
          });
        }
      }

      onProgress?.({ phase: "pushing", done, total: records.length, pushed, errors });
    }

    onProgress?.({ phase: "done", done, total: records.length, pushed, errors });

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

/** Push the current filtered Companies view to Clay. */
export function runCompaniesClayPush(
  filters: CompanyListFilters,
  webhookUrl: string,
  deps: RunClayPushDeps = {}
): Promise<ClayPushResult> {
  return runClayPush(
    { label: "companies", loadRecords: getCompaniesForClay },
    filters,
    webhookUrl,
    deps
  );
}

/** Push the current filtered People view to Clay. */
export function runPeopleClayPush(
  filters: PersonListFilters,
  webhookUrl: string,
  deps: RunClayPushDeps = {}
): Promise<ClayPushResult> {
  return runClayPush(
    { label: "people", loadRecords: getPeopleForClay },
    filters,
    webhookUrl,
    deps
  );
}
