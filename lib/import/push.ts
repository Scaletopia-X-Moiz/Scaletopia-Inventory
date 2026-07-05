import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  normalizeDomain,
  normalizeLinkedInUrl,
  scrubJunkDomain,
  dedupeCompanies,
  dedupePeople,
} from "@/lib/import/normalize";

export interface PushOptions {
  records: Record<string, unknown>[];
  targetTable: "companies" | "people";
  sourceKey: string;
  tags: [string, string, string];
  columnMap: Record<string, string>;
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

/**
 * Map company domain -> companies.id, used to link imported people records
 * to their employer via the real `people.company_id` foreign key (the
 * relation the rest of the app — company detail people-counts, the people
 * drawer — actually reads). Without this, imported people only ever get a
 * loose `domain`/`company_name` text copy with no queryable relation.
 */
async function fetchCompanyIdByDomain(): Promise<Map<string, string>> {
  const rows = await fetchAllRows("companies", "id,domain");
  const map = new Map<string, string>();
  for (const row of rows) {
    if (row.domain && row.id) map.set(row.domain as string, row.id as string);
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

async function bulkInsert(
  records: Record<string, unknown>[],
  targetTable: "companies" | "people",
  sourceKey: string,
  tags: [string, string, string],
  onProgress?: (done: number, total: number) => void
): Promise<{ inserted: number; failed: Record<string, unknown>[] }> {
  let inserted = 0;
  const failed: Record<string, unknown>[] = [];
  const now = new Date().toISOString();
  const total = records.length;

  const prepared = records.map((r) => ({
    ...r,
    source: sourceKey,
    tags,
    last_updated: now,
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

      return {
        domain: r.domain ?? null,
        linkedin_url: r.linkedin_url ?? null,
        tags,
        source: sourceKey,
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

            const query = supabaseAdmin.from("companies").update({
              tags,
              source: sourceKey,
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
    const updatePayload = records.map((r) => {
      const payload: Record<string, unknown> = {
        linkedin_url: r.linkedin_url ?? null,
        email: r.email ?? null,
        company_id: r.company_id ?? null,
        tags,
        source: sourceKey,
        last_updated: now,
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
            });

            if (linkedin) {
              return query.eq("linkedin_url", linkedin);
            } else if (email) {
              return query.ilike("email", email);
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

  const dedupedCount = deduped.length;

  onProgress({ phase: "preflight", done: 0, total: dedupedCount });

  const existingKeys =
    targetTable === "companies"
      ? await fetchExistingCompanies(deduped)
      : await fetchExistingPeople(deduped);

  if (targetTable === "people") {
    const companyIdByDomain = await fetchCompanyIdByDomain();
    for (const rec of deduped) {
      const domain = typeof rec.domain === "string" ? rec.domain : null;
      rec.company_id = domain ? companyIdByDomain.get(domain) ?? null : null;
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

  const { inserted, failed: insertFailed } = await bulkInsert(
    toInsert,
    targetTable,
    sourceKey,
    tags,
    (done, total) => onProgress({ phase: "inserting", done, total })
  );

  onProgress({ phase: "updating", done: 0, total: toUpdate.length });

  const { updated, failed: updateFailed } = await bulkUpdate(
    toUpdate,
    targetTable,
    sourceKey,
    tags,
    (done, total) => onProgress({ phase: "updating", done, total })
  );

  const failedRecords = [...insertFailed, ...updateFailed];
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
}
