import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  submitEmailVerification,
  pollUntilTerminal,
  firstEmail,
  VERIFYING_STATUS,
  type VerifyDeps,
} from "@/lib/icypeas/verify";
import {
  getAllFilteredPeople,
  invalidatePeopleListCache,
  type PersonListFilters,
} from "@/lib/data/people";
import {
  getAllFilteredCompanies,
  invalidateCompaniesListCache,
  type CompanyListFilters,
} from "@/lib/data/companies";

/** Both people and companies expose an `email` and an `email_status` column, so
 * everything here is parameterized by table name. */
export type VerifyTable = "people" | "companies";

/** The list pages read through an hour-long TTL cache (see cache-with-ttl.ts)
 * that's invisible to a plain Supabase `.update()` — without this, a reverify
 * would write the fresh status but every list view would keep serving the
 * pre-reverify snapshot until the TTL naturally expired. Only called right
 * after a write actually happens, so normal browsing pays no extra cost. */
function invalidateListCache(table: VerifyTable): void {
  if (table === "people") invalidatePeopleListCache();
  else invalidateCompaniesListCache();
}

/** Builds the URL Icypeas should POST results to. Reuses NEXT_PUBLIC_SITE_URL
 * (already set for invite links — see .env.example) rather than inventing a
 * separate var, per the task brief's "reuse an existing site-URL env var if
 * one exists". Returns null when unset, which is the expected local-dev
 * state: Icypeas can't call back to a machine with no public URL, so
 * reverifyRecord/runReverify fall back to polling instead of registering a
 * webhook. ICYPEAS_WEBHOOK_URL is an optional override for an environment
 * that wants a webhook path different from the app's own public URL (e.g. a
 * separate tunnel/staging host) — checked first so it always wins when set. */
function getWebhookUrl(): string | null {
  const override = process.env.ICYPEAS_WEBHOOK_URL;
  if (override) return override.replace(/\/$/, "") + "/api/internal/icypeas-webhook";

  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL;
  if (!siteUrl) return null;
  return siteUrl.replace(/\/$/, "") + "/api/internal/icypeas-webhook";
}

// ---------------------------------------------------------------------------
// Single record
// ---------------------------------------------------------------------------

export type ReverifyOutcome =
  // A webhook is configured: the job was submitted and the row was marked
  // `verifying`, but no verdict exists yet — the webhook receiver
  // (app/api/internal/icypeas-webhook) will write the real status when
  // Icypeas calls back. The route/UI should show "verifying…" rather than a
  // final result.
  | { ok: true; pending: true; email: string; status: string }
  // No webhook configured (local dev/testing): pollUntilTerminal already
  // resolved and wrote the final status before returning.
  | {
      ok: true;
      pending: false;
      email: string;
      status: string;
      certainty: string | null;
      credits: number | null;
      verifiedAt: string;
    }
  | { ok: false; code: "not_found" | "no_email" | "verify_failed"; message: string };

/** Reverify one record's email. Icypeas is asynchronous (submit -> webhook or
 * poll, see lib/icypeas/verify.ts), so unlike the old MillionVerifier flow
 * this can no longer always resolve a verdict in one round-trip:
 *
 * 1. Mark the row `email_status = 'verifying'` immediately, so the UI has an
 *    honest in-flight state instead of showing the stale prior status while
 *    we wait.
 * 2. Submit the job with `externalId = "<table>:<id>"` (the webhook receiver
 *    parses this to find the row) and, if a public webhook URL is
 *    configured, `webhookUrl` too.
 * 3. If a webhook URL was registered, return a `pending` outcome — the
 *    webhook receiver will write the real result later.
 * 4. If no webhook URL is configured (local dev has no public URL for
 *    Icypeas to call back to), fall back to `pollUntilTerminal` and write
 *    the resolved result inline, same as before.
 *
 * `last_updated` is intentionally left alone — reverifying is not a data
 * edit, and bumping it would reshuffle the last-updated-sorted lists every
 * time someone clicks verify. */
export async function reverifyRecord(
  table: VerifyTable,
  id: string,
  deps: VerifyDeps = {}
): Promise<ReverifyOutcome> {
  const { data, error } = await supabaseAdmin
    .from(table)
    .select("email")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false, code: "not_found", message: "Record not found" };

  const email = firstEmail(data.email);
  if (!email) {
    return { ok: false, code: "no_email", message: "This record has no email to verify" };
  }

  const { error: markError } = await supabaseAdmin
    .from(table)
    .update({ email_status: VERIFYING_STATUS })
    .eq("id", id);
  if (markError) throw markError;
  invalidateListCache(table);

  const externalId = `${table}:${id}`;
  const webhookUrl = getWebhookUrl();

  let submission;
  try {
    submission = await submitEmailVerification(email, {
      externalId,
      webhookUrl: webhookUrl ?? undefined,
      deps,
    });
  } catch (err) {
    return {
      ok: false,
      code: "verify_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (webhookUrl) {
    return { ok: true, pending: true, email, status: VERIFYING_STATUS };
  }

  // No webhook configured — poll inline (local dev / safety net path).
  let result;
  try {
    result = await pollUntilTerminal(submission.id, { deps, email });
  } catch (err) {
    // The row is left at `verifying` here — there's no prior status to
    // revert to that would be more correct, and a stuck "verifying" is
    // visibly a "something's wrong, reverify again" signal rather than a
    // silently-wrong verdict. Noted as a known tradeoff in the report.
    return {
      ok: false,
      code: "verify_failed",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const verifiedAt = new Date().toISOString();
  const { error: updateError } = await supabaseAdmin
    .from(table)
    .update({ email_status: result.status, email_verified_at: verifiedAt })
    .eq("id", id);
  if (updateError) throw updateError;

  invalidateListCache(table);

  return {
    ok: true,
    pending: false,
    email: result.email,
    status: result.status,
    certainty: result.certainty,
    credits: result.credits,
    verifiedAt,
  };
}

// ---------------------------------------------------------------------------
// Bulk (current filtered view)
// ---------------------------------------------------------------------------

/** Submit concurrency for bulk reverify. The single-search endpoint allows
 * 10 calls/sec (research doc §6), so submitting isn't the bottleneck —
 * `pollUntilTerminal`'s reads are: the `bulk-single-searchs/read` route is
 * capped at 30 calls/min. Each concurrent poller reads roughly
 * (60000 / BULK_POLL_INTERVAL_MS) times/min, so
 * concurrency * (60000 / interval) must stay comfortably under 30. With
 * interval=5000ms that's concurrency * 12 reads/min — 2 pollers ≈ 24/min,
 * safely under the cap.
 *
 * This is the documented fallback from the task brief: a full webhook-driven
 * bulk rework (persisted per-job submission tracking, SSE progress fed by
 * DB writes instead of a single request's control flow) is a materially
 * larger change than "submit + poll with a smaller number and a bigger
 * gap" — see the tradeoff called out in the final report. Every row is
 * still submitted through the same submit+poll path as the single-record
 * fallback, just with lower concurrency and a wider poll interval to respect
 * the shared rate limit. */
const BULK_VERIFY_CONCURRENCY = 2;
const BULK_POLL_INTERVAL_MS = 5000;

/** Cap the failed-email preview returned to the UI (mirrors Clay's preview). */
const FAILED_PREVIEW = 20;

export interface ReverifyProgress {
  phase: "resolving" | "verifying" | "done";
  done: number;
  total: number;
  verified: number;
  errors: number;
}

export interface ReverifyResult {
  total_matched: number;
  /** Rows that came back with a fresh status (any of EMAIL_STATUSES). */
  verified: number;
  /** Rows whose verification threw (network/credits/timeout) — status left
   * as `verifying` rather than reverted (see reverifyRecord's comment on the
   * same tradeoff). */
  errors: number;
  /** Count of resulting statuses across the run, e.g. { ultra_sure: 40,
   * undeliverable: 3 }. */
  counts: Record<string, number>;
  /** Icypeas never returns remaining credits — always null. Kept on the
   * shape so the SSE event/UI contract doesn't need to change. */
  creditsRemaining: number | null;
  /** Preview of emails that failed to verify, capped at FAILED_PREVIEW. */
  failed: string[];
}

export interface RunReverifyDeps extends VerifyDeps {
  onProgress?: (p: ReverifyProgress) => void;
}

interface EmailTarget {
  id: string;
  email: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/** Resolve the current filtered People view into id+email targets. Reuses the
 * exact filtered query the list/export use, so the verified set equals the
 * on-screen set. Rows with no email are dropped (nothing to verify). */
async function resolvePeopleTargets(filters: PersonListFilters): Promise<EmailTarget[]> {
  const rows = await getAllFilteredPeople(filters);
  const targets: EmailTarget[] = [];
  for (const row of rows) {
    const email = firstEmail(row.email);
    if (email) targets.push({ id: row.id, email });
  }
  return targets;
}

/** Companies list rows don't carry `email`, so resolve the filtered ids first
 * (same filtered query as the list/export), then batch-fetch their emails. */
async function resolveCompanyTargets(filters: CompanyListFilters): Promise<EmailTarget[]> {
  const rows = await getAllFilteredCompanies(filters);
  const ids = rows.map((r) => r.id);

  const targets: EmailTarget[] = [];
  for (const idChunk of chunk(ids, 500)) {
    const { data, error } = await supabaseAdmin
      .from("companies")
      .select("id,email")
      .in("id", idChunk);
    if (error) throw error;
    for (const row of data ?? []) {
      const email = firstEmail(row.email as string | null);
      if (email) targets.push({ id: row.id as string, email });
    }
  }
  return targets;
}

interface ReverifyEntity<TFilters> {
  table: VerifyTable;
  resolveTargets: (filters: TFilters) => Promise<EmailTarget[]>;
}

/** Verify one target end-to-end: mark `verifying`, submit, poll to a
 * terminal result, write it. Used by the bulk loop below — see the module
 * comment on BULK_VERIFY_CONCURRENCY for why bulk polls instead of using the
 * webhook (a per-row webhook write happens out-of-band from this request
 * regardless of whether bulk *also* registers one, so registering a webhook
 * here would just mean racing the inline poll against the webhook receiver
 * for the same write — polling only, deliberately, keeps bulk's result
 * accounting inside this one request/SSE stream). */
async function submitAndPoll(
  table: VerifyTable,
  target: EmailTarget,
  deps: VerifyDeps
): Promise<{ status: string; certainty: string | null }> {
  await supabaseAdmin
    .from(table)
    .update({ email_status: VERIFYING_STATUS })
    .eq("id", target.id);

  const submission = await submitEmailVerification(target.email, { deps });
  const result = await pollUntilTerminal(submission.id, {
    deps,
    email: target.email,
    intervalMs: BULK_POLL_INTERVAL_MS,
  });

  const { error } = await supabaseAdmin
    .from(table)
    .update({ email_status: result.status, email_verified_at: new Date().toISOString() })
    .eq("id", target.id);
  if (error) throw error;

  return { status: result.status, certainty: result.certainty };
}

async function runReverify<TFilters>(
  entity: ReverifyEntity<TFilters>,
  filters: TFilters,
  deps: RunReverifyDeps = {}
): Promise<ReverifyResult> {
  const onProgress = deps.onProgress;
  const counts: Record<string, number> = {};
  const failed: string[] = [];
  let verified = 0;
  let errors = 0;
  let done = 0;
  const creditsRemaining: number | null = null; // Icypeas never reports this.

  onProgress?.({ phase: "resolving", done: 0, total: 0, verified: 0, errors: 0 });

  const targets = await entity.resolveTargets(filters);
  const total = targets.length;

  if (total === 0) {
    onProgress?.({ phase: "done", done: 0, total: 0, verified: 0, errors: 0 });
    return { total_matched: 0, verified: 0, errors: 0, counts, creditsRemaining, failed };
  }

  onProgress?.({ phase: "verifying", done: 0, total, verified: 0, errors: 0 });

  for (const group of chunk(targets, BULK_VERIFY_CONCURRENCY)) {
    const results = await Promise.allSettled(
      group.map((target) => submitAndPoll(entity.table, target, deps))
    );

    for (let i = 0; i < results.length; i++) {
      done++;
      const settled = results[i];
      if (settled.status === "fulfilled") {
        verified++;
        const { status } = settled.value;
        counts[status] = (counts[status] ?? 0) + 1;
      } else {
        errors++;
        if (failed.length < FAILED_PREVIEW) failed.push(group[i].email);
      }
    }

    onProgress?.({ phase: "verifying", done, total, verified, errors });
  }

  onProgress?.({ phase: "done", done, total, verified, errors });

  if (verified > 0) invalidateListCache(entity.table);

  return { total_matched: total, verified, errors, counts, creditsRemaining, failed };
}

/** Reverify every email in the current filtered People view. */
export function runPeopleReverify(
  filters: PersonListFilters,
  deps: RunReverifyDeps = {}
): Promise<ReverifyResult> {
  return runReverify({ table: "people", resolveTargets: resolvePeopleTargets }, filters, deps);
}

/** Reverify every email in the current filtered Companies view. */
export function runCompaniesReverify(
  filters: CompanyListFilters,
  deps: RunReverifyDeps = {}
): Promise<ReverifyResult> {
  return runReverify(
    { table: "companies", resolveTargets: resolveCompanyTargets },
    filters,
    deps
  );
}
