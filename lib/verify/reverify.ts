import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { verifyEmail, firstEmail, type VerifyDeps } from "@/lib/millionverifier/verify";
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

/** How many real-time verifications to run at once. MillionVerifier's real-time
 * endpoint is a live SMTP probe per call, so this is deliberately far lower
 * than the Clay push concurrency — we're being polite to their API and the
 * destination mail servers, not saturating a webhook. */
export const VERIFY_CONCURRENCY = 5;

/** Cap the failed-email preview returned to the UI (mirrors Clay's preview). */
const FAILED_PREVIEW = 20;

// ---------------------------------------------------------------------------
// Single record
// ---------------------------------------------------------------------------

export type ReverifyOutcome =
  | {
      ok: true;
      email: string;
      status: string;
      quality: string | null;
      credits: number | null;
      verifiedAt: string;
    }
  | { ok: false; code: "not_found" | "no_email" | "verify_failed"; message: string };

/** Reverify one record's email and persist the fresh status + verified-at
 * timestamp. Returns a tagged outcome so the route can map cleanly onto HTTP
 * codes without try/catch. `last_updated` is intentionally left alone —
 * reverifying is not a data edit, and bumping it would reshuffle the
 * last-updated-sorted lists every time someone clicks verify. */
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

  let result;
  try {
    result = await verifyEmail(email, deps);
  } catch (err) {
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
    email: result.email,
    status: result.status,
    quality: result.quality,
    credits: result.credits,
    verifiedAt,
  };
}

// ---------------------------------------------------------------------------
// Bulk (current filtered view)
// ---------------------------------------------------------------------------

export interface ReverifyProgress {
  phase: "resolving" | "verifying" | "done";
  done: number;
  total: number;
  verified: number;
  errors: number;
}

export interface ReverifyResult {
  total_matched: number;
  /** Rows that came back with a fresh status (any of ok/catch_all/…). */
  verified: number;
  /** Rows whose verification threw (network/credits) — status left unchanged. */
  errors: number;
  /** Count of resulting statuses across the run, e.g. { ok: 40, invalid: 3 }. */
  counts: Record<string, number>;
  /** Credits remaining after the run (last value the API reported), or null. */
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
  let creditsRemaining: number | null = null;

  onProgress?.({ phase: "resolving", done: 0, total: 0, verified: 0, errors: 0 });

  const targets = await entity.resolveTargets(filters);
  const total = targets.length;

  if (total === 0) {
    onProgress?.({ phase: "done", done: 0, total: 0, verified: 0, errors: 0 });
    return { total_matched: 0, verified: 0, errors: 0, counts, creditsRemaining, failed };
  }

  onProgress?.({ phase: "verifying", done: 0, total, verified: 0, errors: 0 });

  for (const group of chunk(targets, VERIFY_CONCURRENCY)) {
    const results = await Promise.allSettled(
      group.map(async (target) => {
        const result = await verifyEmail(target.email, deps);
        const { error } = await supabaseAdmin
          .from(entity.table)
          .update({ email_status: result.status, email_verified_at: new Date().toISOString() })
          .eq("id", target.id);
        if (error) throw error;
        return { target, result };
      })
    );

    for (let i = 0; i < results.length; i++) {
      done++;
      const settled = results[i];
      if (settled.status === "fulfilled") {
        verified++;
        const { status, credits } = settled.value.result;
        counts[status] = (counts[status] ?? 0) + 1;
        if (credits != null) creditsRemaining = credits;
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
