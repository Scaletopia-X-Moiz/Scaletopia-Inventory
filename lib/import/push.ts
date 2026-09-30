import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  normalizeDomain,
  normalizeLinkedInUrl,
  scrubJunkDomain,
  deriveFullName,
  dedupeCompanies,
  dedupePeople,
} from "@/lib/import/normalize";
import { normalizeCountry } from "@/lib/data/country";
import { normalizeIndustry } from "@/lib/data/industry";
import { normalizeSourceTokens } from "@/lib/data/source";
import { nichesFromTags } from "@/lib/data/niche";

export interface PushOptions {
  records: Record<string, unknown>[];
  targetTable: "companies" | "people";
  sourceKey: string;
  tags: [string, string, string];
  // BUG F: `columnMap` was removed — mapping already happens in the route via
  // `applyColumnMap` before records reach `pushRecords`, so it was dead weight
  // here.
}

export interface PushProgress {
  phase:
    | "normalizing"
    | "preflight"
    | "partitioning"
    | "inserting"
    | "updating"
    | "done"
    | "error";
  done: number;
  total: number;
  message?: string;
}

export interface PushResult {
  inputCount: number;
  dedupedCount: number;
  insertedCount: number;
  updatedCount: number;
  failedCount: number;
  failedRecords: Record<string, unknown>[];
  historyId: string | null;
}

export type ProgressCallback = (progress: PushProgress) => void;

/**
 * Format a Supabase/Postgrest error (or arbitrary thrown value) into a short,
 * human-readable reason string for surfacing on individual failed records.
 */
function formatError(error: unknown): string {
  if (error && typeof error === "object") {
    const anyErr = error as { message?: string; code?: string };
    if (anyErr.code && anyErr.message) return `${anyErr.code}: ${anyErr.message}`;
    if (anyErr.message) return anyErr.message;
  }
  return String(error);
}

function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/** Distinct keys per RPC call, and RPC calls in flight at once. 5000 keys is a
 * ~300KB JSON body and a few hundred ms of index probes server-side — far
 * below the 30s service_role statement_timeout. */
export const KEY_CHUNK_SIZE = 5000;
const KEY_CHUNK_CONCURRENCY = 4;

/**
 * Canonical LinkedIn key used for matching an import against stored rows.
 * MUST stay identical to the SQL expression
 *   regexp_replace(lower(rtrim(linkedin_url, '/')), '^https?://(www\.)?', '')
 * used by idx_companies_linkedin_canon / idx_people_linkedin_canon and the
 * import_match_* / import_bulk_update_* RPCs (lib/data/import-key-lookup.sql,
 * lib/import/migrations.sql). Stored URLs are mostly without the trailing
 * slash normalizeLinkedInUrl adds, some are http:// and a few mixed-case;
 * comparing this form on both sides matches all of them without rewriting
 * stored data.
 */
export function canonicalLinkedIn(url: string): string {
  return url
    .replace(/\/+$/, "")
    .toLowerCase()
    .replace(/^https?:\/\/(www\.)?/, "");
}

/** Run `fn` over `keys` in chunks of KEY_CHUNK_SIZE, KEY_CHUNK_CONCURRENCY at a time. */
async function inKeyChunks(
  keys: string[],
  fn: (chunk: string[]) => Promise<void>
): Promise<void> {
  const chunks = chunkArray(keys, KEY_CHUNK_SIZE);
  for (const group of chunkArray(chunks, KEY_CHUNK_CONCURRENCY)) {
    await Promise.all(group.map(fn));
  }
}

/**
 * Look up which of `keysByKind` already exist, via a key-matching RPC that
 * returns `{ kind, keys }` rows (the matching INPUT keys, echoed back). Only
 * the import's own distinct keys travel to the database, and each lookup is an
 * index probe — O(import size), independent of table size. (This replaced
 * downloading the entire table with deep-OFFSET paging, which hit the 30s
 * statement_timeout at ~390k companies.)
 *
 * Any RPC error throws: a partial lookup would misclassify existing records as
 * new and duplicate-insert them (or hit a 23505 on domain), so the push must
 * abort instead.
 */
async function matchExistingKeys(
  rpc: "import_match_companies" | "import_match_people",
  params: Record<string, string>,
  keysByKind: Record<string, string[]>
): Promise<Set<string>> {
  const existingKeys = new Set<string>();
  const paramNames = Object.values(params);
  for (const [kind, keys] of Object.entries(keysByKind)) {
    await inKeyChunks(keys, async (chunk) => {
      const args: Record<string, string[]> = {};
      for (const p of paramNames) args[p] = [];
      args[params[kind]] = chunk;
      const { data, error } = await supabaseAdmin.rpc(rpc, args);
      if (error) {
        throw new Error(`Failed to look up existing keys (${rpc}): ${formatError(error)}`);
      }
      for (const row of (data ?? []) as { kind: string; keys: string[] | null }[]) {
        for (const k of row.keys ?? []) existingKeys.add(`${row.kind}:${k}`);
      }
    });
  }
  return existingKeys;
}

function distinct(values: (string | null)[]): string[] {
  return Array.from(new Set(values.filter((v): v is string => !!v)));
}

function recordDomain(rec: Record<string, unknown>): string | null {
  return typeof rec.domain === "string" && rec.domain ? rec.domain : null;
}

function recordLinkedInKey(rec: Record<string, unknown>): string | null {
  return typeof rec.linkedin_url === "string" && rec.linkedin_url
    ? canonicalLinkedIn(rec.linkedin_url)
    : null;
}

function recordEmailKey(rec: Record<string, unknown>): string | null {
  return typeof rec.email === "string" && rec.email ? rec.email.toLowerCase() : null;
}

async function fetchExistingCompanies(
  records: Record<string, unknown>[]
): Promise<Set<string>> {
  // A record is considered existing if its domain OR its (canonical)
  // linkedin_url is already present anywhere in the table.
  return matchExistingKeys(
    "import_match_companies",
    { domain: "p_domains", linkedin: "p_linkedins" },
    {
      domain: distinct(records.map(recordDomain)),
      linkedin: distinct(records.map(recordLinkedInKey)),
    }
  );
}

/** A company row's fields needed to link an imported person to their
 * employer and to populate the person's canonical columns (docs/adr/0001-...
 * and lib/data/people-canonical-columns.sql) from the linked company's own
 * already-canonical `industry_id`/`employee_count`/`linkedin_url`/`niche`. */
export interface PersonCompanyRow {
  id: string;
  client: string | null;
  niche: string | null;
  industry_id: string | null;
  employee_count: number | null;
  linkedin_url: string | null;
}

/**
 * Map company domain -> full company row, used to link imported people
 * records to their employer via the real `people.company_id` foreign key (the
 * relation the rest of the app — company detail people-counts, the people
 * drawer — actually reads) and to carry the company's canonical fields onto
 * the person row. Without this, imported people only ever get a loose
 * `domain`/`company_name` text copy with no queryable relation.
 */
async function fetchCompanyIdByDomain(
  records: Record<string, unknown>[]
): Promise<Map<string, PersonCompanyRow>> {
  // Only the companies this import's people actually point at (by domain) —
  // not the whole table.
  const map = new Map<string, PersonCompanyRow>();
  await inKeyChunks(distinct(records.map(recordDomain)), async (chunk) => {
    const { data, error } = await supabaseAdmin.rpc("import_companies_by_domain", {
      p_domains: chunk,
    });
    if (error) {
      throw new Error(`Failed to look up companies by domain: ${formatError(error)}`);
    }
    for (const row of (data ?? []) as (PersonCompanyRow & { domain: string | null })[]) {
      if (row.domain && row.id) {
        map.set(row.domain, {
          id: row.id,
          client: row.client ?? null,
          niche: row.niche ?? null,
          industry_id: row.industry_id ?? null,
          employee_count: row.employee_count ?? null,
          linkedin_url: row.linkedin_url ?? null,
        });
      }
    }
  });
  return map;
}

/** Lower-cased, trimmed distinct companies.client values — the "known client"
 * names nichesFromTags strips from a person's source tags. Previously derived
 * from the full companies download; now a skip-scan RPC over
 * idx_companies_client. */
async function fetchKnownClients(): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin.rpc("import_known_clients");
  if (error) {
    throw new Error(`Failed to fetch known clients: ${formatError(error)}`);
  }
  const clients = new Set<string>();
  for (const c of (data ?? []) as string[]) {
    const k = typeof c === "string" ? c.trim().toLowerCase() : "";
    if (k) clients.add(k);
  }
  return clients;
}

async function fetchExistingPeople(
  records: Record<string, unknown>[]
): Promise<Set<string>> {
  return matchExistingKeys(
    "import_match_people",
    { linkedin: "p_linkedins", email: "p_emails" },
    {
      linkedin: distinct(records.map(recordLinkedInKey)),
      email: distinct(records.map(recordEmailKey)),
    }
  );
}

function recordExistsKey(
  rec: Record<string, unknown>,
  existingKeys: Set<string>
): boolean {
  const domain = recordDomain(rec);
  const linkedin = recordLinkedInKey(rec);
  const email = recordEmailKey(rec);

  if (domain && existingKeys.has(`domain:${domain}`)) return true;
  if (linkedin && existingKeys.has(`linkedin:${linkedin}`)) return true;
  if (email && existingKeys.has(`email:${email}`)) return true;
  return false;
}

async function insertWithBinarySplit(
  batch: Record<string, unknown>[],
  targetTable: "companies" | "people"
): Promise<{ inserted: number; failed: Record<string, unknown>[] }> {
  const { error } = await supabaseAdmin.from(targetTable).insert(batch);
  if (!error) return { inserted: batch.length, failed: [] };
  if (batch.length === 1) {
    return {
      inserted: 0,
      failed: [{ ...batch[0], _failure_reason: formatError(error) }],
    };
  }

  const mid = Math.floor(batch.length / 2);
  const [left, right] = await Promise.all([
    insertWithBinarySplit(batch.slice(0, mid), targetTable),
    insertWithBinarySplit(batch.slice(mid), targetTable),
  ]);
  return {
    inserted: left.inserted + right.inserted,
    failed: [...left.failed, ...right.failed],
  };
}

/** Recomputes country_id/industry_id on an in-progress enrichment payload from
 * whatever raw country/industry string it just set, mirroring the COALESCE
 * semantics of those raw fields (only set — and re-normalized — when this
 * record actually supplies a new raw value, so omitting country doesn't clear
 * an existing country_id). Shared by the primary bulk-update payload and its
 * individual-record fallback so the two paths can't drift. */
function withCanonicalIdentityIds(enrichment: Record<string, unknown>): void {
  if (typeof enrichment.country === "string") {
    enrichment.country_id = normalizeCountry(enrichment.country)?.id ?? null;
  }
  if (typeof enrichment.industry === "string") {
    enrichment.industry_id = normalizeIndustry(enrichment.industry)?.id ?? null;
  }
}

async function bulkInsert(
  records: Record<string, unknown>[],
  targetTable: "companies" | "people",
  sourceKey: string,
  tags: [string, string, string],
  companyById: Map<string, PersonCompanyRow>,
  knownClients: Set<string>,
  onProgress?: (done: number, total: number) => void
): Promise<{ inserted: number; failed: Record<string, unknown>[] }> {
  let inserted = 0;
  const failed: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  const total = records.length;

  // Canonical columns (docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md,
  // extended to people by docs/adr/0001-.../lib/data/people-canonical-columns.sql) are
  // computed here so a fresh insert never needs a separate backfill pass.
  const canonicalColumnsFor = (r: Record<string, unknown>): Record<string, unknown> => {
    if (targetTable === "companies") {
      return {
        country_id: normalizeCountry(r.country as string | null | undefined)?.id ?? null,
        industry_id: normalizeIndustry(r.industry as string | null | undefined)?.id ?? null,
        source_tokens: normalizeSourceTokens(sourceKey),
        // Ticket #83: `tags` is [client, niche, date] (app/api/import/autocomplete/
        // route.ts). Companies has its own dedicated client/niche columns
        // (unlike people, which only ever gets a derived niche_tokens array) —
        // this was previously never written on insert, so the Tag Metadata
        // step's values were silently dropped despite showing correctly in the
        // pre-push "TAGS TO APPLY" summary.
        client: tags[0] || null,
        niche: tags[1] || null,
      };
    }

    // people: country_id/source_tokens are normalized from the record's own
    // raw fields. industry_id/employee_count/company_linkedin_url mirror the
    // linked company's own already-canonical columns (not re-normalized —
    // copied directly). niche_tokens (what the People Niche facet counts) is
    // resolved in priority order: (1) the linked company's own niche, (2) this
    // push's Tag Metadata niche — tags[1] of the [client, niche, date] tuple,
    // the value the user picked for the whole import, (3) as a last resort,
    // niches parsed from the record's OWN source tags (r.tags, distinct from
    // the push-level tuple). Tier 2 is the fix for the common case where the
    // import has a Tag Metadata niche but the rows carry no source tags: that
    // used to fall straight to (3) on an empty r.tags and leave niche_tokens [].
    const company = r.company_id ? companyById.get(r.company_id as string) : undefined;
    return {
      country_id: normalizeCountry(r.country as string | null | undefined)?.id ?? null,
      source_tokens: normalizeSourceTokens(sourceKey),
      industry_id: company?.industry_id ?? null,
      employee_count: company?.employee_count ?? null,
      company_linkedin_url: company?.linkedin_url ?? null,
      niche_tokens: company?.niche
        ? [company.niche]
        : tags[1]
          ? [tags[1]]
          : nichesFromTags(r.tags as string[] | undefined, knownClients),
    };
  };

  const prepared = records.map((r) => ({
    ...r,
    source: sourceKey,
    tags,
    last_updated: now,
    ...canonicalColumnsFor(r),
  }));

  const batches = chunkArray(prepared, 1000);
  const parallelism = 8;

  for (const group of chunkArray(batches, parallelism)) {
    const results = await Promise.all(
      group.map((batch) => insertWithBinarySplit(batch, targetTable))
    );
    for (const r of results) {
      inserted += r.inserted;
      failed.push(...r.failed);
    }
    onProgress?.(inserted + failed.length, total);
  }

  return { inserted, failed };
}

async function bulkUpdate(
  records: Record<string, unknown>[],
  targetTable: "companies" | "people",
  sourceKey: string,
  tags: [string, string, string],
  companyById: Map<string, PersonCompanyRow>,
  knownClients: Set<string>,
  onProgress?: (done: number, total: number) => void
): Promise<{ updated: number; failed: Record<string, unknown>[] }> {
  let updated = 0;
  const failed: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  const total = records.length;

  if (targetTable === "companies") {
    const updatePayload = records.map((r) => {
      const enrichment: Record<string, unknown> = {};

      const stringFields = [
        "company_name", "website_url", "linkedin_url", "industry",
        "city", "state", "country", "phone", "email", "description", "revenue",
      ] as const;
      for (const f of stringFields) {
        if (typeof r[f] === "string" && r[f] !== "") enrichment[f] = r[f];
      }

      for (const f of ["employee_count", "founded_year"] as const) {
        if (r[f] !== null && r[f] !== undefined && r[f] !== "") enrichment[f] = r[f];
      }

      const cd = r.custom_data;
      if (cd && typeof cd === "object" && !Array.isArray(cd)) enrichment.custom_data = cd;

      // Ticket #83: companies has dedicated client/niche columns that a
      // fresh insert already sets (see bulkInsert's canonicalColumnsFor) but
      // an update never wrote — the Tag Metadata step's values would show
      // correctly in the pre-push summary yet never land on an existing
      // record. `tags` is this whole push's [client, niche, date] tuple, so
      // it's the same for every record here, not read off `r`.
      if (tags[0]) enrichment.client = tags[0];
      if (tags[1]) enrichment.niche = tags[1];

      // Canonical columns (docs/adr/0001-...). country_id/industry_id mirror
      // the COALESCE semantics of the raw string fields above — only included
      // (and re-normalized) when this record actually supplies a new raw
      // value, so a record that omits country doesn't clear an existing
      // country_id. source_tokens is different: `source` is *appended to*
      // (see the RPC's dedupe-append CASE), not overwritten, so the RPC does
      // the corresponding array union itself — new_source_tokens here is just
      // this record's own canonical token(s), not the row's final set.
      withCanonicalIdentityIds(enrichment);

      return {
        domain: r.domain ?? null,
        linkedin_url: r.linkedin_url ?? null,
        tags,
        source: sourceKey,
        new_source_tokens: normalizeSourceTokens(sourceKey),
        last_updated: now,
        ...enrichment,
      };
    });

    const { error: rpcError } = await supabaseAdmin.rpc(
      "import_bulk_update_companies",
      { updates: updatePayload }
    );

    if (!rpcError) {
      updated = records.length;
      onProgress?.(updated, total);
    } else {
      // Fall back to individual parallel updates in batches of 20
      for (const batch of chunkArray(records, 20)) {
        const results = await Promise.allSettled(
          batch.map((rec) => {
            const domain =
              typeof rec.domain === "string" ? rec.domain : null;
            const linkedin =
              typeof rec.linkedin_url === "string" ? rec.linkedin_url : null;

            const enrichment: Record<string, unknown> = {};
            const stringFields = [
              "company_name", "website_url", "linkedin_url", "industry",
              "city", "state", "country", "phone", "email", "description", "revenue",
            ] as const;
            for (const f of stringFields) {
              if (typeof rec[f] === "string" && rec[f] !== "") enrichment[f] = rec[f];
            }
            for (const f of ["employee_count", "founded_year"] as const) {
              if (rec[f] !== null && rec[f] !== undefined && rec[f] !== "") enrichment[f] = rec[f];
            }
            // Ticket #83: mirror the primary RPC payload above — client/niche
            // must land on this fallback path too, not just the happy path.
            if (tags[0]) enrichment.client = tags[0];
            if (tags[1]) enrichment.niche = tags[1];
            withCanonicalIdentityIds(enrichment);

            const query = supabaseAdmin.from("companies").update({
              tags,
              source: sourceKey,
              // Rare error-recovery path (the bulk RPC above already failed):
              // overwrites source_tokens with just this record's own token(s)
              // rather than unioning with whatever was already there, unlike
              // the RPC path. Acceptable for a fallback that only runs when
              // the primary path has already errored.
              source_tokens: normalizeSourceTokens(sourceKey),
              last_updated: now,
              ...enrichment,
            });

            if (domain) {
              return query.eq("domain", domain);
            } else if (linkedin) {
              return query.eq("linkedin_url", linkedin);
            }
            return Promise.resolve({ error: new Error("no key") });
          })
        );

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (
            r.status === "fulfilled" &&
            (!("error" in r.value) || !r.value.error)
          ) {
            updated++;
          } else {
            const reason =
              r.status === "fulfilled"
                ? formatError((r.value as { error?: unknown }).error)
                : formatError(r.reason);
            failed.push({ ...batch[i], _failure_reason: reason });
          }
        }
        onProgress?.(updated + failed.length, total);
      }
    }
  } else {
    // Canonical columns (docs/adr/0001-..., lib/data/people-canonical-columns.sql).
    // Mirrors the insert-path logic in bulkInsert's canonicalColumnsFor: the
    // company-derived fields (industry_id/employee_count/company_linkedin_url/
    // niche_tokens) are only included when this record resolved a company, so
    // omitting them lets the RPC's COALESCE / "key present" check preserve
    // whatever the row already had. country_id is deliberately never touched
    // here — import_bulk_update_people's contract leaves it alone because the
    // update path doesn't rewrite people's raw `country`.
    const companyEnrichmentFor = (r: Record<string, unknown>): Record<string, unknown> => {
      if (!r.company_id) return {};
      const company = companyById.get(r.company_id as string);
      return {
        industry_id: company?.industry_id ?? null,
        employee_count: company?.employee_count ?? null,
        company_linkedin_url: company?.linkedin_url ?? null,
        // niche_tokens: mirror bulkInsert's priority — company niche, then the
        // Tag Metadata niche (tags[1]), then niches parsed from the record's own
        // source tags (r.tags).
        niche_tokens: company?.niche
          ? [company.niche]
          : tags[1]
            ? [tags[1]]
            : nichesFromTags(r.tags as string[] | undefined, knownClients),
      };
    };

    const updatePayload = records.map((r) => {
      const payload: Record<string, unknown> = {
        linkedin_url: r.linkedin_url ?? null,
        email: r.email ?? null,
        company_id: r.company_id ?? null,
        tags,
        source: sourceKey,
        new_source_tokens: normalizeSourceTokens(sourceKey),
        last_updated: now,
        ...companyEnrichmentFor(r),
      };
      const cd = r.custom_data;
      if (cd && typeof cd === "object" && !Array.isArray(cd)) payload.custom_data = cd;
      return payload;
    });

    const { error: rpcError } = await supabaseAdmin.rpc(
      "import_bulk_update_people",
      { updates: updatePayload }
    );

    if (!rpcError) {
      updated = records.length;
      onProgress?.(updated, total);
    } else {
      for (const batch of chunkArray(records, 20)) {
        const results = await Promise.allSettled(
          batch.map((rec) => {
            const linkedin =
              typeof rec.linkedin_url === "string" ? rec.linkedin_url : null;
            const email =
              typeof rec.email === "string" ? rec.email : null;
            const query = supabaseAdmin.from("people").update({
              tags,
              source: sourceKey,
              last_updated: now,
              // Only overwrite company_id when we actually resolved one for
              // this row; a lookup miss shouldn't unlink an existing match.
              ...(rec.company_id ? { company_id: rec.company_id } : {}),
              // Rare error-recovery path (the bulk RPC above already failed):
              // best-effort mirror of the RPC's canonical-column writes.
              // source_tokens is overwritten with just this record's own
              // token(s) rather than unioned with whatever was already
              // there, unlike the RPC path — acceptable for a fallback that
              // only runs once the primary path has errored.
              source_tokens: normalizeSourceTokens(sourceKey),
              ...companyEnrichmentFor(rec),
            });

            // BUG A: mirror the SQL RPC's deterministic precedence — prefer
            // linkedin_url as the identity and only fall back to email when the
            // record has no linkedin. This one-record-updates-one-row intent
            // means a record with a linkedin never matches unrelated people by
            // a shared email.
            if (linkedin) {
              return query.eq("linkedin_url", linkedin);
            } else if (email) {
              // People emails are stored verbatim (not lowercased on insert),
              // so match case-insensitively like the SQL path (lower(email) =
              // lower(...)). `.ilike` is case-insensitive but treats `%`/`_` as
              // wildcards — and `_` is a legal email char — so escape those
              // metacharacters to get a case-insensitive EXACT match rather
              // than an accidental over-match.
              const escapedEmail = email.replace(/([\\%_])/g, "\\$1");
              return query.ilike("email", escapedEmail);
            }
            return Promise.resolve({ error: new Error("no key") });
          })
        );

        for (let i = 0; i < results.length; i++) {
          const r = results[i];
          if (
            r.status === "fulfilled" &&
            (!("error" in r.value) || !r.value.error)
          ) {
            updated++;
          } else {
            const reason =
              r.status === "fulfilled"
                ? formatError((r.value as { error?: unknown }).error)
                : formatError(r.reason);
            failed.push({ ...batch[i], _failure_reason: reason });
          }
        }
        onProgress?.(updated + failed.length, total);
      }
    }
  }

  return { updated, failed };
}

/**
 * Normalizes and dedupes raw mapped records into the exact list an import
 * processes. Pure and order-preserving: the same input always yields the same
 * output in the same order, which is what lets a resumable import re-run this
 * on every tick and slice the result by a saved offset (T22).
 *
 * `deriveNames` fills a missing people `full_name` from first/last name
 * (ticket 74). `pushRecords` and the import worker want it; `preflightRecords`
 * has never done it and its counts don't depend on it.
 */
export function prepareImportRecords(
  records: Record<string, unknown>[],
  targetTable: "companies" | "people",
  { deriveNames = true }: { deriveNames?: boolean } = {}
): Record<string, unknown>[] {
  const normalized = records.map((rec) => {
    const out = { ...rec };

    const rawDomain = out.domain as string | null | undefined;
    const rawLinkedin = out.linkedin_url as string | null | undefined;
    const rawWebsite = out.website_url as string | null | undefined;

    const normalizedDomain = scrubJunkDomain(normalizeDomain(rawDomain));
    const normalizedLinkedin = normalizeLinkedInUrl(rawLinkedin);

    // If no explicit domain, try to derive from website_url
    const derivedDomain =
      normalizedDomain ?? scrubJunkDomain(normalizeDomain(rawWebsite));

    out.domain = derivedDomain;
    out.linkedin_url = normalizedLinkedin;

    // Ticket 74: when a people source (e.g. Manual CSV) provides First
    // Name / Last Name but no explicit Full Name column, full_name would
    // otherwise land as null — blank in the People list and unfindable via
    // the name search box (lib/data/search.ts only searches
    // full_name/email). Never overwrites an explicit Full Name value.
    if (deriveNames && targetTable === "people") {
      out.full_name = deriveFullName(
        out.full_name as string | null | undefined,
        out.first_name as string | null | undefined,
        out.last_name as string | null | undefined
      );
    }

    return out;
  });

  return targetTable === "companies"
    ? dedupeCompanies(normalized)
    : dedupePeople(normalized);
}

export interface PreflightResult {
  inputCount: number;
  dedupedCount: number;
  insertCount: number;
  updateCount: number;
}

export async function preflightRecords(
  records: Record<string, unknown>[],
  targetTable: "companies" | "people"
): Promise<PreflightResult> {
  const inputCount = records.length;

  // Preflight has never derived full_name (it doesn't affect the counts it
  // reports), so keep skipping it here rather than change what it returns.
  const deduped = prepareImportRecords(records, targetTable, { deriveNames: false });
  const dedupedCount = deduped.length;

  const existingKeys =
    targetTable === "companies"
      ? await fetchExistingCompanies(deduped)
      : await fetchExistingPeople(deduped);

  let insertCount = 0;
  let updateCount = 0;
  for (const rec of deduped) {
    if (recordExistsKey(rec, existingKeys)) {
      updateCount++;
    } else {
      insertCount++;
    }
  }

  return { inputCount, dedupedCount, insertCount, updateCount };
}

/** Records handled per resumable chunk. Bounds each `import_bulk_update_*` RPC
 * call (which receives its whole array in one statement) and each in-memory
 * existing-keys refresh, and is the granularity at which a tick can stop for
 * its deadline. */
export const IMPORT_TICK_CHUNK = 2000;

export interface ImportTickOptions {
  records: Record<string, unknown>[];
  targetTable: "companies" | "people";
  sourceKey: string;
  tags: [string, string, string];
  /** Index into the DEDUPED list to resume from (0 for a fresh stage). */
  offset: number;
  /** Epoch ms. The tick stops after the chunk in flight once this passes. */
  deadline: number;
  chunkSize?: number;
  /** Fired after preflight and after each chunk; the worker uses it as the
   * lease heartbeat. `done`/`total` are deduped-list positions. */
  onProgress?: ProgressCallback;
  /** Optional live sink, updated after every chunk (and once the deduped
   * count is known). Lets a caller that catches a mid-tick throw still record
   * the work that already landed (BUG E). */
  partial?: ImportTickResult;
  /** Awaited once after dedupe (before the key fetch, cursor unchanged) and
   * again after every chunk, with this tick's cumulative deltas. The worker
   * persists cursor + counts here so a hard kill loses at most one chunk and
   * the progress bar moves during the first tick. A throw propagates out of
   * the tick. */
  onCheckpoint?: (state: ImportTickResult) => Promise<void>;
  /** Polled before each chunk (including the first). Returning true ends the
   * tick early (the worker uses it when it has lost its lease). */
  shouldStop?: () => boolean;
  /** Conservative floor, in ms, for how long one chunk may take. A new chunk is
   * only started when `now + max(minChunkMs, 1.5 x slowest chunk so far)` fits
   * before `deadline`, leaving headroom for the DB statement timeout. The first
   * chunk always runs. Default 0. */
  minChunkMs?: number;
}

export interface ImportTickResult {
  dedupedCount: number;
  /** Deduped-list index the next tick should resume from. */
  nextOffset: number;
  done: boolean;
  /** This tick's deltas only, not running totals. */
  inserted: number;
  updated: number;
  failedRecords: Record<string, unknown>[];
}

/** Adds the lookup keys of a record that was just inserted to the in-memory
 * existing-keys set, mirroring what fetchExistingCompanies/People would have
 * loaded for it. Only the keys those fetchers load are added: adding e.g. an
 * `email:` key for a company would make later companies match on an email the
 * real existing set never contains. */
function addInsertedKeys(
  rec: Record<string, unknown>,
  targetTable: "companies" | "people",
  existingKeys: Set<string>
): void {
  const domain = typeof rec.domain === "string" ? rec.domain : null;
  // Same canonical form recordExistsKey() looks up, so a later record in the
  // same import matches one inserted earlier.
  const linkedin = recordLinkedInKey(rec);
  const email = typeof rec.email === "string" ? rec.email.toLowerCase() : null;
  if (targetTable === "companies" && domain) existingKeys.add(`domain:${domain}`);
  if (linkedin) existingKeys.add(`linkedin:${linkedin}`);
  if (targetTable === "people" && email) existingKeys.add(`email:${email}`);
}

function recordSignature(rec: Record<string, unknown>): string {
  return [rec.domain, rec.linkedin_url, rec.email]
    .map((v) => (typeof v === "string" ? v : ""))
    .join("|");
}

/**
 * Runs one resumable slice of an import (T22): prepare (normalize + dedupe) the
 * records, fetch existing keys ONCE, then process `deduped[offset…]` in
 * fixed-size chunks until the list is exhausted or `deadline` passes. Always
 * processes at least one chunk so a tick can't stall on an already-expired
 * deadline.
 *
 * Crash recovery is at-least-once per chunk (the cursor is persisted after each
 * chunk via `onCheckpoint`, so a rerun is at most one chunk). Rows that have a
 * lookup key (domain / linkedin_url for companies; email / linkedin_url for
 * people) are re-applied as updates on a rerun: they are "existing" by then,
 * which is safe and can only shift counts toward "updated". Rows with NO key
 * (a company with only company_name, a person with only a name) can never match
 * `existingKeys`, so a rerun of the crashed chunk INSERTS THEM AGAIN. Those are
 * not idempotent; this is a known limitation (see ADR 0006).
 */
export async function runImportTick(opts: ImportTickOptions): Promise<ImportTickResult> {
  const { records, targetTable, sourceKey, tags, offset, deadline, onProgress, partial } = opts;
  const chunkSize = opts.chunkSize ?? IMPORT_TICK_CHUNK;

  const deduped = prepareImportRecords(records, targetTable);
  const dedupedCount = deduped.length;
  if (partial) partial.dedupedCount = dedupedCount;

  onProgress?.({ phase: "preflight", done: offset, total: dedupedCount });

  const existingKeys =
    targetTable === "companies"
      ? await fetchExistingCompanies(deduped)
      : await fetchExistingPeople(deduped);

  // Populated only for targetTable === "people"; passed through to bulkInsert
  // and bulkUpdate so they can derive the person canonical columns from the
  // linked company's own already-canonical fields without a second full
  // companies-table fetch.
  const companyById = new Map<string, PersonCompanyRow>();
  const knownClients = new Set<string>();
  let companyByDomain = new Map<string, PersonCompanyRow>();

  if (targetTable === "people") {
    const [byDomain, clients] = await Promise.all([
      fetchCompanyIdByDomain(deduped),
      fetchKnownClients(),
    ]);
    companyByDomain = byDomain;
    for (const company of companyByDomain.values()) {
      companyById.set(company.id, company);
    }
    for (const c of clients) knownClients.add(c);
  }

  let inserted = 0;
  let updated = 0;
  const failedRecords: Record<string, unknown>[] = [];
  let position = Math.min(offset, dedupedCount);
  if (partial) partial.nextOffset = position;

  let slowestChunkMs = 0;
  let chunksRun = 0;
  const checkpoint = async () => {
    if (!opts.onCheckpoint) return;
    await opts.onCheckpoint({
      dedupedCount,
      nextOffset: position,
      done: position >= dedupedCount,
      inserted,
      updated,
      failedRecords: [...failedRecords],
    });
  };
  // Early checkpoint: total is known as soon as dedupe is done, so the
  // progress bar has a denominator during the whole first tick.
  await checkpoint();

  while (position < dedupedCount) {
    if (opts.shouldStop?.()) break;
    if (chunksRun > 0) {
      const estimate = Math.max(opts.minChunkMs ?? 0, slowestChunkMs * 1.5);
      if (Date.now() + estimate > deadline) break;
    }
    const chunkStartedAt = Date.now();
    const chunk = deduped.slice(position, position + chunkSize);

    if (targetTable === "people") {
      for (const rec of chunk) {
        const domain = typeof rec.domain === "string" ? rec.domain : null;
        rec.company_id = domain ? companyByDomain.get(domain)?.id ?? null : null;
      }
    }

    const toInsert: Record<string, unknown>[] = [];
    const toUpdate: Record<string, unknown>[] = [];
    for (const rec of chunk) {
      if (recordExistsKey(rec, existingKeys)) {
        toUpdate.push(rec);
      } else {
        toInsert.push(rec);
      }
    }

    const { inserted: ins, failed: insertFailed } = await bulkInsert(
      toInsert,
      targetTable,
      sourceKey,
      tags,
      companyById,
      knownClients
    );
    inserted += ins;
    failedRecords.push(...insertFailed);

    // Rows this chunk just inserted are now existing rows for the chunks that
    // follow. Skip records that failed to insert (matched by key signature,
    // since bulkInsert returns copies).
    const failedSignatures = new Set(insertFailed.map(recordSignature));
    for (const rec of toInsert) {
      if (!failedSignatures.has(recordSignature(rec))) {
        addInsertedKeys(rec, targetTable, existingKeys);
      }
    }

    // Skip the RPC for a chunk with nothing to update: per-chunk calls would
    // otherwise fire an empty `updates` array at the database every chunk.
    if (toUpdate.length > 0) {
      const { updated: upd, failed: updateFailed } = await bulkUpdate(
        toUpdate,
        targetTable,
        sourceKey,
        tags,
        companyById,
        knownClients
      );
      updated += upd;
      failedRecords.push(...updateFailed);
    }

    position += chunk.length;
    if (partial) {
      partial.inserted = inserted;
      partial.updated = updated;
      partial.failedRecords = [...failedRecords];
      partial.nextOffset = position;
    }
    onProgress?.({ phase: "inserting", done: position, total: dedupedCount });
    await checkpoint();

    chunksRun += 1;
    slowestChunkMs = Math.max(slowestChunkMs, Date.now() - chunkStartedAt);
  }

  return {
    dedupedCount,
    nextOffset: position,
    done: position >= dedupedCount,
    inserted,
    updated,
    failedRecords,
  };
}

export async function pushRecords(
  options: PushOptions,
  onProgress: ProgressCallback
): Promise<PushResult> {
  const { records, targetTable, sourceKey, tags } = options;
  const inputCount = records.length;

  // BUG E: track running counts in the outer scope so that if this push throws
  // partway (or the serverless function is killed at `maxDuration`), the catch
  // block below can still write an `import_history` row reflecting whatever
  // inserts/updates actually landed, instead of the partial work being
  // completely invisible. This is a CONTAINED fix — it records what happened,
  // it does NOT attempt resumability/checkpointing.
  let dedupedCount = 0;
  let inserted = 0;
  let updated = 0;
  let failedRecords: Record<string, unknown>[] = [];
  const partial: ImportTickResult = {
    dedupedCount: 0,
    nextOffset: 0,
    done: false,
    inserted: 0,
    updated: 0,
    failedRecords: [],
  };

  try {
    onProgress({ phase: "normalizing", done: 0, total: inputCount });

    // T22: the processing itself now lives in runImportTick (shared with the
    // queued import worker). This wrapper is the legacy single-shot path — no
    // deadline, so it runs every chunk in one go — and keeps writing
    // `import_history` exactly as before.
    // `partial` is a live sink the tick keeps current after every chunk, so if
    // it throws mid-way the BUG E catch below still sees what already landed.
    const tick = await runImportTick({
      records,
      targetTable,
      sourceKey,
      tags,
      offset: 0,
      deadline: Infinity,
      onProgress,
      partial,
    });

    dedupedCount = tick.dedupedCount;
    inserted = tick.inserted;
    updated = tick.updated;
    failedRecords = tick.failedRecords;

    const failedCount = failedRecords.length;

    onProgress({ phase: "done", done: dedupedCount, total: dedupedCount });

    let historyId: string | null = null;
    const { data: historyData } = await supabaseAdmin
      .from("import_history")
      .insert({
        source_key: sourceKey,
        target_table: targetTable,
        tags,
        input_count: inputCount,
        deduped_count: dedupedCount,
        inserted_count: inserted,
        updated_count: updated,
        failed_count: failedCount,
        failed_records: failedRecords,
        completed_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (historyData) historyId = historyData.id;

    return {
      inputCount,
      dedupedCount,
      insertedCount: inserted,
      updatedCount: updated,
      failedCount,
      failedRecords,
      historyId,
    };
  } catch (err) {
    // BUG E: best-effort partial-history write on failure. `import_history` has
    // no status/error column, so the error is recorded as a synthetic entry in
    // the existing `failed_records` jsonb and counted in `failed_count`. This
    // makes a timed-out/errored run (and any rows that DID land) visible in
    // history instead of vanishing. We still re-throw so the caller surfaces
    // the error to the client. If this history write itself fails, swallow it —
    // the original error is what matters.
    dedupedCount = partial.dedupedCount;
    inserted = partial.inserted;
    updated = partial.updated;
    failedRecords = partial.failedRecords;
    const errorMarker = {
      _import_error: formatError(err),
      _partial: true,
    };
    const partialFailed = [...failedRecords, errorMarker];
    try {
      await supabaseAdmin.from("import_history").insert({
        source_key: sourceKey,
        target_table: targetTable,
        tags,
        input_count: inputCount,
        deduped_count: dedupedCount,
        inserted_count: inserted,
        updated_count: updated,
        failed_count: partialFailed.length,
        failed_records: partialFailed,
        completed_at: new Date().toISOString(),
      });
    } catch {
      // Swallow — surfacing the original push error takes priority.
    }
    throw err;
  }
}
