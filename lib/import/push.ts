import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  normalizeDomain,
  normalizeLinkedInUrl,
  scrubJunkDomain,
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

const KEY_PAGE_SIZE = 1000;
const KEY_PAGE_CONCURRENCY = 12;

/**
 * Fetch every row of `columns` from `table` using paginated range requests.
 *
 * The previous implementation chunked the import's domains / linkedin_urls into
 * batches of 2000 and issued `.in(column, batch)` queries. With large imports
 * (~20k rows) those IN-lists produced ~50KB request URLs, which PostgREST is
 * extremely slow to parse — a single push could take over a minute. The
 * existing tables are small (tens of thousands of rows), so it is dramatically
 * faster (and simpler, and more correct) to pull the entire key-set once in
 * small fixed-size pages and test membership locally. This is O(table size)
 * rather than O(import size), and never builds a giant URL.
 */
async function fetchAllRows(
  table: "companies" | "people",
  columns: string
): Promise<Record<string, unknown>[]> {
  // `.range()` alone gives Postgres no guaranteed row order, so separate
  // paginated queries can return rows in different physical order (e.g.
  // under concurrent writes) and silently skip or duplicate rows across
  // pages even though the total `count` still checks out. Ordering by `id`
  // makes pagination deterministic and gapless.
  const first = await supabaseAdmin
    .from(table)
    .select(columns, { count: "exact" })
    .order("id", { ascending: true })
    .range(0, KEY_PAGE_SIZE - 1);

  // A failed page here previously fell through silently (`if (r.data)`),
  // so a transient timeout/rate-limit on the existing-keys fetch would
  // quietly drop rows from the dedupe set — causing already-imported
  // records to be misclassified as new and either duplicate-inserted
  // (columns with no unique constraint, e.g. linkedin_url) or rejected
  // with a 23505 unique-violation (columns with one, e.g. domain). Throw
  // instead so a partial fetch aborts the push rather than corrupting it.
  if (first.error) {
    throw new Error(
      `Failed to fetch existing ${table} rows (page 0): ${formatError(first.error)}`
    );
  }

  const rows: Record<string, unknown>[] = first.data
    ? [...(first.data as unknown as Record<string, unknown>[])]
    : [];
  const total = first.count ?? rows.length;
  if (total <= KEY_PAGE_SIZE) return rows;

  const pageCount = Math.ceil(total / KEY_PAGE_SIZE);
  // Page 0 already fetched; queue the remaining page start offsets.
  const pageStarts: number[] = [];
  for (let p = 1; p < pageCount; p++) pageStarts.push(p * KEY_PAGE_SIZE);

  // Fetch remaining pages with bounded concurrency to avoid exhausting
  // connections on very large tables.
  for (const group of chunkArray(pageStarts, KEY_PAGE_CONCURRENCY)) {
    const results = await Promise.all(
      group.map((from) =>
        supabaseAdmin
          .from(table)
          .select(columns)
          .order("id", { ascending: true })
          .range(from, from + KEY_PAGE_SIZE - 1)
      )
    );
    for (const r of results) {
      if (r.error) {
        throw new Error(
          `Failed to fetch existing ${table} rows: ${formatError(r.error)}`
        );
      }
      if (r.data) rows.push(...(r.data as unknown as Record<string, unknown>[]));
    }
  }

  if (rows.length !== total) {
    throw new Error(
      `Fetched ${rows.length} of ${total} existing ${table} rows — pagination ` +
        `returned fewer rows than expected, aborting rather than pushing with an incomplete dedupe set`
    );
  }

  return rows;
}

async function fetchExistingCompanies(
  _records: Record<string, unknown>[]
): Promise<Set<string>> {
  const rows = await fetchAllRows("companies", "domain,linkedin_url");

  // A record is considered existing if its domain OR its linkedin_url is
  // already present anywhere in the table. Encode both as namespaced keys.
  const existingKeys = new Set<string>();
  for (const row of rows) {
    if (row.domain) existingKeys.add(`domain:${row.domain}`);
    if (row.linkedin_url) existingKeys.add(`linkedin:${row.linkedin_url}`);
  }
  return existingKeys;
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
async function fetchCompanyIdByDomain(): Promise<Map<string, PersonCompanyRow>> {
  const rows = await fetchAllRows(
    "companies",
    "id,domain,client,niche,industry_id,employee_count,linkedin_url"
  );
  const map = new Map<string, PersonCompanyRow>();
  for (const row of rows) {
    if (row.domain && row.id) {
      map.set(row.domain as string, {
        id: row.id as string,
        client: (row.client as string | null) ?? null,
        niche: (row.niche as string | null) ?? null,
        industry_id: (row.industry_id as string | null) ?? null,
        employee_count: (row.employee_count as number | null) ?? null,
        linkedin_url: (row.linkedin_url as string | null) ?? null,
      });
    }
  }
  return map;
}

async function fetchExistingPeople(
  _records: Record<string, unknown>[]
): Promise<Set<string>> {
  const rows = await fetchAllRows("people", "linkedin_url,email");

  const existingKeys = new Set<string>();
  for (const row of rows) {
    if (row.linkedin_url) existingKeys.add(`linkedin:${row.linkedin_url}`);
    if (row.email) existingKeys.add(`email:${String(row.email).toLowerCase()}`);
  }
  return existingKeys;
}

function recordExistsKey(
  rec: Record<string, unknown>,
  existingKeys: Set<string>
): boolean {
  const domain = typeof rec.domain === "string" ? rec.domain : null;
  const linkedin =
    typeof rec.linkedin_url === "string" ? rec.linkedin_url : null;
  const email = typeof rec.email === "string" ? rec.email.toLowerCase() : null;

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
      };
    }

    // people: country_id/source_tokens are normalized from the record's own
    // raw fields. industry_id/employee_count/company_linkedin_url mirror the
    // linked company's own already-canonical columns (not re-normalized —
    // copied directly). niche_tokens prefers the company's niche and only
    // falls back to parsing the person's own tags when the company has none.
    const company = r.company_id ? companyById.get(r.company_id as string) : undefined;
    return {
      country_id: normalizeCountry(r.country as string | null | undefined)?.id ?? null,
      source_tokens: normalizeSourceTokens(sourceKey),
      industry_id: company?.industry_id ?? null,
      employee_count: company?.employee_count ?? null,
      company_linkedin_url: company?.linkedin_url ?? null,
      niche_tokens: company?.niche
        ? [company.niche]
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
        niche_tokens: company?.niche
          ? [company.niche]
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

  const normalized = records.map((rec) => {
    const out = { ...rec };
    const rawDomain = out.domain as string | null | undefined;
    const rawLinkedin = out.linkedin_url as string | null | undefined;
    const rawWebsite = out.website_url as string | null | undefined;
    const normalizedDomain = scrubJunkDomain(normalizeDomain(rawDomain));
    const normalizedLinkedin = normalizeLinkedInUrl(rawLinkedin);
    const derivedDomain = normalizedDomain ?? scrubJunkDomain(normalizeDomain(rawWebsite));
    out.domain = derivedDomain;
    out.linkedin_url = normalizedLinkedin;
    return out;
  });

  const deduped =
    targetTable === "companies" ? dedupeCompanies(normalized) : dedupePeople(normalized);
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

  try {
    onProgress({ phase: "normalizing", done: 0, total: inputCount });

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

      return out;
    });

    const deduped =
      targetTable === "companies"
        ? dedupeCompanies(normalized)
        : dedupePeople(normalized);

    dedupedCount = deduped.length;

    onProgress({ phase: "preflight", done: 0, total: dedupedCount });

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

    if (targetTable === "people") {
      const companyByDomain = await fetchCompanyIdByDomain();
      for (const company of companyByDomain.values()) {
        companyById.set(company.id, company);
        if (company.client) knownClients.add(company.client.trim().toLowerCase());
      }
      for (const rec of deduped) {
        const domain = typeof rec.domain === "string" ? rec.domain : null;
        rec.company_id = domain ? companyByDomain.get(domain)?.id ?? null : null;
      }
    }

    onProgress({ phase: "partitioning", done: dedupedCount, total: dedupedCount });

    const toInsert: Record<string, unknown>[] = [];
    const toUpdate: Record<string, unknown>[] = [];

    for (const rec of deduped) {
      if (recordExistsKey(rec, existingKeys)) {
        toUpdate.push(rec);
      } else {
        toInsert.push(rec);
      }
    }

    onProgress({ phase: "inserting", done: 0, total: toInsert.length });

    const { inserted: ins, failed: insertFailed } = await bulkInsert(
      toInsert,
      targetTable,
      sourceKey,
      tags,
      companyById,
      knownClients,
      (done, total) => onProgress({ phase: "inserting", done, total })
    );
    inserted = ins;
    failedRecords = [...insertFailed];

    onProgress({ phase: "updating", done: 0, total: toUpdate.length });

    const { updated: upd, failed: updateFailed } = await bulkUpdate(
      toUpdate,
      targetTable,
      sourceKey,
      tags,
      companyById,
      knownClients,
      (done, total) => onProgress({ phase: "updating", done, total })
    );
    updated = upd;
    failedRecords = [...failedRecords, ...updateFailed];

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
