import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { verifyPhone, type VerifyDeps } from "@/lib/clearout-phone/verify";
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

/** Parallel to lib/verify/reverify.ts (email), kept as a fully separate module
 * on purpose — the email reverify path is working and was hard-won, and a bug
 * here shouldn't be able to touch it. Both people and companies expose a
 * `phone`, `phone_status`, `phone_type` and `phone_verified_at` column, so
 * everything here is parameterized by table name exactly like the email
 * version. */
export type VerifyTable = "people" | "companies";

/** Neither people.phone nor companies.phone hold comma-separated multiple
 * values (verified live against the DB), so unlike firstEmail there's no
 * first-of-N to pick — just trim. Returns null when there's nothing to verify. */
export function firstPhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed ? trimmed : null;
}

function invalidateListCache(table: VerifyTable): void {
  if (table === "people") invalidatePeopleListCache();
  else invalidateCompaniesListCache();
}

/** Same politeness budget as the email reverify path — ClearoutPhone is a
 * live carrier-lookup API, not a bulk endpoint to saturate. */
export const VERIFY_CONCURRENCY = 5;

/** Cap the failed-number preview returned to the UI (mirrors email). */
const FAILED_PREVIEW = 20;

// ---------------------------------------------------------------------------
// Single record
// ---------------------------------------------------------------------------

export type ReverifyOutcome =
  | {
      ok: true;
      phone: string;
      status: string;
      lineType: string | null;
      verifiedAt: string;
    }
  | { ok: false; code: "not_found" | "no_phone" | "verify_failed"; message: string };

/** Reverify one record's phone and persist the fresh status + line type +
 * verified-at timestamp. `last_updated` is intentionally left alone —
 * reverifying is not a data edit, and bumping it would reshuffle the
 * last-updated-sorted lists every time someone clicks verify. */
export async function reverifyPhoneRecord(
  table: VerifyTable,
  id: string,
  deps: VerifyDeps = {}
): Promise<ReverifyOutcome> {
  const { data, error } = await supabaseAdmin
    .from(table)
    .select("phone")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return { ok: false, code: "not_found", message: "Record not found" };

  const phone = firstPhone(data.phone);
  if (!phone) {
    return { ok: false, code: "no_phone", message: "This record has no phone number to verify" };
  }

  let result;
  try {
    result = await verifyPhone(phone, deps);
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
    .update({
      phone_status: result.status,
      phone_type: result.lineType,
      phone_verified_at: verifiedAt,
    })
    .eq("id", id);
  if (updateError) throw updateError;

  invalidateListCache(table);

  return {
    ok: true,
    phone: result.phone,
    status: result.status,
    lineType: result.lineType,
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
  /** Rows that came back with a fresh status (valid/invalid/…). */
  verified: number;
  /** Rows whose verification threw (network/auth) — status left unchanged. */
  errors: number;
  /** Count of resulting statuses across the run, e.g. { valid: 40, invalid: 3 }. */
  counts: Record<string, number>;
  /** Preview of phone numbers that failed to verify, capped at FAILED_PREVIEW. */
  failed: string[];
}

export interface RunReverifyDeps extends VerifyDeps {
  onProgress?: (p: ReverifyProgress) => void;
}

interface PhoneTarget {
  id: string;
  phone: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/** Resolve the current filtered People view into id+phone targets. Reuses the
 * exact filtered query the list/export use, so the verified set equals the
 * on-screen set. Rows with no phone are dropped (nothing to verify). */
async function resolvePeopleTargets(filters: PersonListFilters): Promise<PhoneTarget[]> {
  const rows = await getAllFilteredPeople(filters);
  const targets: PhoneTarget[] = [];
  for (const row of rows) {
    const phone = firstPhone(row.phone);
    if (phone) targets.push({ id: row.id, phone });
  }
  return targets;
}

/** Companies list rows already carry `phone`, but resolve through the same
 * filtered query as the list/export for consistency with the email path. */
async function resolveCompanyTargets(filters: CompanyListFilters): Promise<PhoneTarget[]> {
  const rows = await getAllFilteredCompanies(filters);
  const targets: PhoneTarget[] = [];
  for (const row of rows) {
    const phone = firstPhone(row.phone);
    if (phone) targets.push({ id: row.id, phone });
  }
  return targets;
}

interface ReverifyEntity<TFilters> {
  table: VerifyTable;
  resolveTargets: (filters: TFilters) => Promise<PhoneTarget[]>;
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

  onProgress?.({ phase: "resolving", done: 0, total: 0, verified: 0, errors: 0 });

  const targets = await entity.resolveTargets(filters);
  const total = targets.length;

  if (total === 0) {
    onProgress?.({ phase: "done", done: 0, total: 0, verified: 0, errors: 0 });
    return { total_matched: 0, verified: 0, errors: 0, counts, failed };
  }

  onProgress?.({ phase: "verifying", done: 0, total, verified: 0, errors: 0 });

  for (const group of chunk(targets, VERIFY_CONCURRENCY)) {
    const results = await Promise.allSettled(
      group.map(async (target) => {
        const result = await verifyPhone(target.phone, deps);
        const { error } = await supabaseAdmin
          .from(entity.table)
          .update({
            phone_status: result.status,
            phone_type: result.lineType,
            phone_verified_at: new Date().toISOString(),
          })
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
        const { status } = settled.value.result;
        counts[status] = (counts[status] ?? 0) + 1;
      } else {
        errors++;
        if (failed.length < FAILED_PREVIEW) failed.push(group[i].phone);
      }
    }

    onProgress?.({ phase: "verifying", done, total, verified, errors });
  }

  onProgress?.({ phase: "done", done, total, verified, errors });

  if (verified > 0) invalidateListCache(entity.table);

  return { total_matched: total, verified, errors, counts, failed };
}

/** Reverify every phone number in the current filtered People view. */
export function runPeopleReverify(
  filters: PersonListFilters,
  deps: RunReverifyDeps = {}
): Promise<ReverifyResult> {
  return runReverify({ table: "people", resolveTargets: resolvePeopleTargets }, filters, deps);
}

/** Reverify every phone number in the current filtered Companies view. */
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
