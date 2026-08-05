import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/data/fetch-all-rows";
import { normalizeSourceTokens, sourceLabel } from "@/lib/data/source";
import { countryLabel } from "@/lib/data/country";
import { industryLabel } from "@/lib/data/industry";
import { EMPLOYEE_BUCKETS, employeeBucketOf } from "@/lib/data/employee-size";
import { filterCustomData, toWebhookCustomData } from "@/lib/data/custom-data";
import { sortByLastUpdatedDesc } from "@/lib/data/sort";
import type { ClayPushRecord } from "@/lib/clay/types";
import type { IncludeExclude } from "@/lib/data/include-exclude";
import type { ActiveVirtualColumn, VirtualFilterSet } from "@/lib/data/virtual-columns";
import { isFilterSetActive } from "@/lib/data/virtual-columns";
import {
  pushStatusRpcPayload,
  type PushPlatform,
  type PushStatusCounts,
  type PushStatusFilter,
} from "@/lib/data/push-status-filter";
import { getPushJobPersonIds, type PushJobOutcome } from "@/lib/data/push-jobs";

export type SingleSelectFilter = "any" | "not_empty" | "empty";

export interface CompanyListFilters {
  search?: string;
  niche?: IncludeExclude;
  source?: IncludeExclude;
  industry?: IncludeExclude;
  employeeBucket?: string[];
  country?: IncludeExclude;
  employeeMin?: number;
  employeeMax?: number;
  email?: SingleSelectFilter;
  phone?: SingleSelectFilter;
  emailStatus?: IncludeExclude;
  phoneType?: IncludeExclude;
  /** Restrict to companies a push run touched — the companies linked (via
   * people.company_id) to the people tagged in `push_job_records` for this job
   * (#123). Same people→company link the Companies-triggered push uses in
   * getPeopleForEmailBisonByCompanyFilters. Resolved to a company-id set
   * (resolvePushJobCompanyIds); there's no company-level push record. */
  pushJobId?: string;
  /** Optional outcome sub-scope for pushJobId — restrict the underlying people
   * to only succeeded / only failed records before mapping to companies.
   * Undefined (default) keeps all touched records. */
  pushJobOutcome?: PushJobOutcome;
  /** Push-status filter (client × platform × pushed/not_pushed). Shared shape
   * with PersonListFilters via lib/data/push-status-filter.ts. Only the type
   * and RPC payload key land here (#126) — predicate evaluation is F2/C1. */
  pushStatus?: PushStatusFilter;
  /** Virtual-column predicates over custom_data enrichment fields (ticket #33,
   * docs/adr/0002-virtual-column-enrichment-filtering.md). Evaluated by the
   * shared SQL predicate (lib/data/virtual-columns.sql), not the PostgREST
   * builder below — see resolveVirtualFilterIds. Two-level grouped AND/OR
   * logic since ticket #117 (a single AND group reproduces the pre-#117 flat
   * behavior). */
  virtualFilters?: VirtualFilterSet;
  /** Enrichment fields added as display-only virtual columns on the rendered
   * page (independent of virtualFilters — a column can be shown before it has
   * a filter). Only getCompanies (the rendered page) reads this; it has no
   * bearing on which rows match, so it's not part of toFilterOptionsRpcPayload. */
  virtualColumns?: ActiveVirtualColumn[];
}

export interface CompanyListRow {
  id: string;
  companyName: string | null;
  brandName: string | null;
  domain: string | null;
  websiteUrl: string | null;
  linkedinUrl: string | null;
  industry: string | null;
  employeeCount: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  phoneType: string | null;
  phoneStatus: string | null;
  phoneVerifiedAt: string | null;
  email: string | null;
  emailStatus: string | null;
  emailVerifiedAt: string | null;
  niche: string | null;
  sources: string[];
  qualityTier: string | null;
  lastUpdated: string | null;
  /** Count of people rows linked via people.company_id — only populated for
   * getCompanies (the rendered table page), not getAllFilteredCompanies
   * (export), so exporting the full filtered set doesn't pay for a people
   * lookup on every row. */
  peopleCount?: number;
  /** custom_data[key] per active virtual column (filters.virtualColumns) —
   * only populated for getCompanies, matching peopleCount's page-only scope. */
  virtualColumnValues?: Record<string, unknown>;
}

export interface CompanyListResult {
  rows: CompanyListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FilterOption {
  id: string;
  label: string;
  count: number;
}

export interface CompanyFilterOptions {
  niches: FilterOption[];
  sources: FilterOption[];
  industries: FilterOption[];
  countries: FilterOption[];
  employeeBuckets: { id: string; label: string }[];
  emailStatuses: FilterOption[];
  phoneTypes: FilterOption[];
}

interface RawCompanyRow {
  id: string;
  company_name: string | null;
  brand_name: string | null;
  domain: string | null;
  website_url: string | null;
  linkedin_url: string | null;
  industry: string | null;
  employee_count: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  phone_type: string | null;
  phone_status: string | null;
  phone_verified_at: string | null;
  email: string | null;
  email_status: string | null;
  email_verified_at: string | null;
  source: string | null;
  niche: string | null;
  quality_tier: string | null;
  last_updated: string | null;
}

const LIST_COLUMNS =
  "id,company_name,brand_name,domain,website_url,linkedin_url,industry,employee_count,city,state,country,phone,phone_type,phone_status,phone_verified_at,email,email_status,email_verified_at,source,niche,quality_tier,last_updated";

function employeeBucketOrClause(bucketIds: string[]): string {
  const buckets = EMPLOYEE_BUCKETS.filter((b) => bucketIds.includes(b.id));
  return buckets
    .map((b) =>
      b.max === null
        ? `employee_count.gte.${b.min}`
        : `and(employee_count.gte.${b.min},employee_count.lte.${b.max})`
    )
    .join(",");
}

function employeeBucketRanges(bucketIds: string[]): { min_v: number; max_v: number | null }[] {
  return EMPLOYEE_BUCKETS.filter((b) => bucketIds.includes(b.id)).map((b) => ({
    min_v: b.min,
    max_v: b.max,
  }));
}

/** Applies an include/exclude filter to a scalar (single-valued) column, e.g.
 * niche, industry_id, country_id, email_status, phone_type. `.in`/`.notIn`
 * both append a separate querystring filter on the same column, and PostgREST
 * ANDs same-column filters together — exactly the "exclude wins, include must
 * also match" semantics lib/data/include-exclude.ts's matchesIncludeExclude
 * implements in-app. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyScalarIncludeExclude(query: any, column: string, filter: IncludeExclude | undefined): any {
  if (!filter) return query;
  let q = query;
  if (filter.exclude.length) q = q.notIn(column, filter.exclude);
  if (filter.include.length) q = q.in(column, filter.include);
  return q;
}

/** Applies an include/exclude filter to source_tokens (multi-valued: a row
 * can carry several canonical source tokens). Include matches any overlap
 * (`&&`); exclude rejects any overlap. Source tokens are our own canonical
 * slugs (aiark, blitz, apollo, ...) with no delimiter/reserved characters, so
 * the manual `{a,b}` literal below is safe without PostgREST's quoting. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applySourceIncludeExclude(query: any, filter: IncludeExclude | undefined): any {
  if (!filter) return query;
  let q = query;
  if (filter.exclude.length) q = q.not("source_tokens", "ov", `{${filter.exclude.join(",")}}`);
  if (filter.include.length) q = q.overlaps("source_tokens", filter.include);
  return q;
}

/** Presence filter on a nullable text column: "not_empty" excludes both NULL
 * and '' (matching the in-app `!row.field` truthy check this replaces),
 * "empty" matches either. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyPresenceFilter(query: any, column: string, filter: SingleSelectFilter | undefined): any {
  if (filter === "not_empty") return query.not(column, "is", null).neq(column, "");
  if (filter === "empty") return query.or(`${column}.is.null,${column}.eq.`);
  return query;
}

/** Pushes every /companies filter into Postgres: search (ILIKE), employee
 * size (range or bucket OR-clause), and the four canonical-column filters
 * (niche, source, industry, country) plus email/phone presence and status —
 * all cleanly pushable now that country_id/industry_id/source_tokens hold the
 * normalized form (see docs/adr/0001-...). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyCompanyFilters(query: any, filters: CompanyListFilters): any {
  let q = query;

  const search = filters.search?.trim();
  if (search) {
    const term = search.replace(/[%,]/g, "");
    q = q.or(`company_name.ilike.%${term}%,domain.ilike.%${term}%`);
  }

  if (filters.employeeMin != null || filters.employeeMax != null) {
    if (filters.employeeMin != null) q = q.gte("employee_count", filters.employeeMin);
    if (filters.employeeMax != null) q = q.lte("employee_count", filters.employeeMax);
  } else if (filters.employeeBucket?.length) {
    const clause = employeeBucketOrClause(filters.employeeBucket);
    if (clause) q = q.or(clause);
  }

  q = applyScalarIncludeExclude(q, "niche", filters.niche);
  q = applySourceIncludeExclude(q, filters.source);
  q = applyScalarIncludeExclude(q, "industry_id", filters.industry);
  q = applyScalarIncludeExclude(q, "country_id", filters.country);
  q = applyPresenceFilter(q, "email", filters.email);
  q = applyPresenceFilter(q, "phone", filters.phone);
  q = applyScalarIncludeExclude(q, "email_status", filters.emailStatus);
  q = applyScalarIncludeExclude(q, "phone_type", filters.phoneType);

  return q;
}

interface VirtualFilterIdRow {
  id: string;
}

/** PostgREST caps a single response — including an RPC's result set — at 1000
 * rows (see fetchAllRows above), so a virtual filter matching more than 1000
 * companies would otherwise come back silently truncated to the first 1000:
 * confirmed live, a filter matching 2673 rows returned exactly 1000 with no
 * error. Paged the same way fetchAllRows pages a table query. */
const RPC_PAGE_SIZE = 1000;

/** Resolves the id set filters.virtualFilters (or filters.pushStatus) narrows
 * to via the shared SQL predicate (lib/data/virtual-columns.sql), or `null`
 * when neither a virtual filter nor a push filter is active — the no-op case
 * every list/export/push call site below must preserve exactly, so existing
 * behavior with no filter active stays byte-identical. The push predicate rides
 * the same seam: companies_matching_virtual_filters (F2) applies it in SQL from
 * the payload's `pushStatus` key with the company "has work left" semantics (a
 * company matches not_pushed if >=1 linked person is not yet pushed to that
 * client/platform, pushed if it has people and all are pushed), and a virtual
 * filter AND a push filter active together intersect in that one scan. Kept
 * separate from applyCompanyFilters because PostgREST's query builder can't express the
 * predicate's cast-safe numeric/date comparisons (see ADR-0002) — the
 * predicate has to be evaluated in SQL, not built through the builder. Sends
 * the *full* filter payload (not just virtualFilters) so
 * companies_matching_virtual_filters can apply the same native predicate
 * applyCompanyFilters would, bounding its scan to the actual working set
 * instead of the whole table — the point of ticket #33's "no path pays for a
 * second scan" requirement. */
async function resolveVirtualFilterIds(filters: CompanyListFilters): Promise<string[] | null> {
  if (!isFilterSetActive(filters.virtualFilters) && !filters.pushStatus) return null;
  const payload = toFilterOptionsRpcPayload(filters);

  const first = await supabaseAdmin
    .rpc("companies_matching_virtual_filters", { filters: payload }, { count: "exact" })
    .range(0, RPC_PAGE_SIZE - 1);
  if (first.error) throw first.error;

  const ids = (first.data as VirtualFilterIdRow[]).map((row) => row.id);
  const total = first.count ?? ids.length;

  const pageCount = Math.ceil(total / RPC_PAGE_SIZE);
  if (pageCount > 1) {
    const pages = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, i) => {
        const start = (i + 1) * RPC_PAGE_SIZE;
        return supabaseAdmin
          .rpc("companies_matching_virtual_filters", { filters: payload })
          .range(start, start + RPC_PAGE_SIZE - 1);
      })
    );
    for (const page of pages) {
      if (page.error) throw page.error;
      ids.push(...(page.data as VirtualFilterIdRow[]).map((row) => row.id));
    }
  }

  return ids;
}

async function fetchFilteredRows(filters: CompanyListFilters): Promise<RawCompanyRow[]> {
  const restricted = await resolveRestrictedRows(filters);
  if (restricted !== null) return restricted;
  return fetchAllRows<RawCompanyRow>("companies", LIST_COLUMNS, (query) =>
    applyCompanyFilters(query, filters)
  );
}

/** No-op — kept so callers (clean-names, reverify, reverify-phone) don't need
 * touching. There is no app-level cache to invalidate now that filtering,
 * faceting, and sorting all run in Postgres on every request. */
export function invalidateCompaniesListCache(): void {}

function toListRow(row: RawCompanyRow): CompanyListRow {
  return {
    id: row.id,
    companyName: row.company_name,
    brandName: row.brand_name,
    domain: row.domain,
    websiteUrl: row.website_url,
    linkedinUrl: row.linkedin_url,
    industry: row.industry,
    employeeCount: row.employee_count,
    city: row.city,
    state: row.state,
    country: row.country,
    phone: row.phone,
    phoneType: row.phone_type,
    phoneStatus: row.phone_status,
    phoneVerifiedAt: row.phone_verified_at,
    email: row.email,
    emailStatus: row.email_status,
    emailVerifiedAt: row.email_verified_at,
    niche: row.niche,
    sources: normalizeSourceTokens(row.source),
    qualityTier: row.quality_tier,
    lastUpdated: row.last_updated,
  };
}

/** Split an id list into fixed-size chunks. Every by-id query below fans out
 * this way to keep each `.in()` clause's query string under URL length limits —
 * a single `.in()` built from ~1000 UUIDs was long enough to fail the request
 * outright. */
function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/** Ids per `.in()` chunk when re-fetching rows for a resolved virtual-filter id
 * set below. */
const VIRTUAL_FILTER_ROW_CHUNK_SIZE = 200;

/** LIST_COLUMNS rows for a virtual-filter id set (resolveVirtualFilterIds),
 * fanned out and merged the same way fetchCompaniesByIds handles the full `*`
 * fetch further down. Confirmed empirically against the live table: a single
 * `.in("id", ids)` (or an equivalent single-request `.or()` of `in.(...)`
 * groups) throws PostgREST's "Bad Request" once the id list runs past a few
 * hundred entries — Postgres/PostgREST rejects the request outright before it
 * ever reaches the query planner, so this isn't a "make the query cheaper"
 * problem, it's a "the request can't be one HTTP call" problem. ids are
 * already the *complete* filtered set (resolveVirtualFilterIds sends the full
 * filter payload, not just virtualFilters), so no filters need reapplying
 * here — just the id lookup. */
async function fetchRowsForVirtualIds(ids: string[]): Promise<RawCompanyRow[]> {
  if (ids.length === 0) return [];
  const chunks = chunkIds(ids, VIRTUAL_FILTER_ROW_CHUNK_SIZE);
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      fetchAllRows<RawCompanyRow>("companies", LIST_COLUMNS, (query) => query.in("id", chunk))
    )
  );
  return chunkResults.flat();
}

/** Ids per `.in("id", ...)` chunk when mapping person ids → company ids below. */
const PUSH_JOB_PERSON_ID_CHUNK_SIZE = 200;

/** The distinct company ids that filters.pushJobId restricts to — the
 * companies linked (via people.company_id) to the people tagged in
 * `push_job_records` for that job — or null when no pushJobId is set. People
 * with no linked company are dropped; a job that touched only such people (or
 * an empty job) yields an empty set, not null. */
async function resolvePushJobCompanyIds(filters: CompanyListFilters): Promise<string[] | null> {
  if (!filters.pushJobId) return null;
  const personIds = await getPushJobPersonIds(filters.pushJobId, filters.pushJobOutcome);
  if (personIds.length === 0) return [];

  const chunks = chunkIds(personIds, PUSH_JOB_PERSON_ID_CHUNK_SIZE);
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      fetchAllRows<{ company_id: string | null }>("people", "company_id", (query) =>
        query.in("id", chunk)
      )
    )
  );
  const companyIds = new Set<string>();
  for (const rows of chunkResults) {
    for (const row of rows) if (row.company_id) companyIds.add(row.company_id);
  }
  return [...companyIds];
}

/** LIST_COLUMNS rows for a company-id set with the *standard* filters reapplied
 * per chunk — the pushJobId path, where the id set comes from
 * push_job_records→people and hasn't had the standard filters applied (unlike
 * the virtual-filter RPC, which bakes them in). Chunked for the same
 * URL-length reason as fetchRowsForVirtualIds. */
async function fetchRowsForRestrictedIds(
  ids: string[],
  filters: CompanyListFilters
): Promise<RawCompanyRow[]> {
  if (ids.length === 0) return [];
  const chunks = chunkIds(ids, VIRTUAL_FILTER_ROW_CHUNK_SIZE);
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      fetchAllRows<RawCompanyRow>("companies", LIST_COLUMNS, (query) =>
        applyCompanyFilters(query.in("id", chunk), filters)
      )
    )
  );
  return chunkResults.flat();
}

/** The fully filtered LIST rows (unsorted) when any id-restricting dimension is
 * active — virtualFilters, pushJobId, or both — or null to signal "use the
 * plain PostgREST path". Mirrors resolveRestrictedRows in lib/data/people.ts:
 *  - virtual only: the RPC already applied the standard filters, fetch by id.
 *  - pushJobId (± other standard filters): reapply standard filters per chunk.
 *  - both: intersect the sets; the virtual RPC already carries standard
 *    filters, so the intersection needs only an id lookup. */
async function resolveRestrictedRows(filters: CompanyListFilters): Promise<RawCompanyRow[] | null> {
  const [virtualIds, pushCompanyIds] = await Promise.all([
    resolveVirtualFilterIds(filters),
    resolvePushJobCompanyIds(filters),
  ]);
  if (virtualIds === null && pushCompanyIds === null) return null;
  if (pushCompanyIds === null) return fetchRowsForVirtualIds(virtualIds as string[]);
  if (virtualIds === null) return fetchRowsForRestrictedIds(pushCompanyIds, filters);
  const virtualSet = new Set(virtualIds);
  return fetchRowsForVirtualIds(pushCompanyIds.filter((id) => virtualSet.has(id)));
}

/** Ids per `.in()` chunk when querying people-by-company below. */
const PEOPLE_COUNT_ID_CHUNK_SIZE = 100;

/** People linked to each company, scoped to just the ids on the rendered
 * page — avoids both an N+1 (one count query per row) and pulling the whole
 * people table (which dwarfs companies) just to tally a handful of rows.
 * PostgREST has no GROUP BY, so this fetches the matching company_id column
 * (paginated via fetchAllRows in case a chunk's companies collectively link
 * to more than 1000 people) and reduces the counts in app code. */
async function getPeopleCountsForCompanies(ids: string[]): Promise<Map<string, number>> {
  const counts = new Map<string, number>();
  if (ids.length === 0) return counts;

  const chunks = chunkIds(ids, PEOPLE_COUNT_ID_CHUNK_SIZE);

  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      fetchAllRows<{ company_id: string | null }>("people", "company_id", (query) =>
        query.in("company_id", chunk)
      )
    )
  );

  for (const rows of chunkResults) {
    for (const row of rows) {
      if (!row.company_id) continue;
      counts.set(row.company_id, (counts.get(row.company_id) ?? 0) + 1);
    }
  }
  return counts;
}

/** Ids per `.in()` chunk when querying enrichment values by id below. */
const ENRICHMENT_VALUES_ID_CHUNK_SIZE = 100;

/** custom_data[key] for each active virtual column, scoped to just the ids on
 * the rendered page — same shape/reasoning as getPeopleCountsForCompanies:
 * avoids pulling the whole custom_data blob (and the whole table) just to
 * populate a handful of display columns for one page. */
async function getCompanyEnrichmentValues(
  ids: string[],
  keys: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();
  if (ids.length === 0 || keys.length === 0) return result;

  const chunks = chunkIds(ids, ENRICHMENT_VALUES_ID_CHUNK_SIZE);
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      fetchAllRows<{ id: string; custom_data: Record<string, unknown> | null }>(
        "companies",
        "id,custom_data",
        (query) => query.in("id", chunk)
      )
    )
  );

  for (const rows of chunkResults) {
    for (const row of rows) {
      const values: Record<string, unknown> = {};
      for (const key of keys) values[key] = row.custom_data?.[key] ?? null;
      result.set(row.id, values);
    }
  }
  return result;
}

/** The rendered /companies list page: filter, sort, and paginate entirely in
 * Postgres (see docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md).
 * Deep pages degrade gradually as OFFSET discards preceding rows — accepted
 * per the ADR since real users don't page that deep, and it keeps the
 * jump-to-any-page UI with zero frontend changes. */
export async function getCompanies(
  filters: CompanyListFilters,
  page = 1,
  pageSize = 50
): Promise<CompanyListResult> {
  const restricted = await resolveRestrictedRows(filters);
  const start = (page - 1) * pageSize;

  let pageRows: CompanyListRow[];
  let total: number;

  if (restricted !== null) {
    // An id-restricting dimension is active (virtualFilters and/or pushJobId):
    // the matched id set can't be pushed into a single `.in()`/`.range()`
    // Postgres query past a few hundred ids (see fetchRowsForVirtualIds), so
    // order/paginate in app code over the already-resolved full match instead —
    // the same tradeoff getAllFilteredCompanies already makes for export.
    const matched = sortByLastUpdatedDesc(restricted);
    total = matched.length;
    pageRows = matched.slice(start, start + pageSize).map(toListRow);
  } else {
    let query = supabaseAdmin.from("companies").select(LIST_COLUMNS, { count: "exact" });
    query = applyCompanyFilters(query, filters);
    query = query
      .order("last_updated", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true });

    const { data, error, count } = await query.range(start, start + pageSize - 1);
    if (error) throw error;

    const rows = (data ?? []) as unknown as RawCompanyRow[];
    pageRows = rows.map(toListRow);
    total = count ?? 0;
  }
  const peopleCounts = await getPeopleCountsForCompanies(pageRows.map((r) => r.id));
  for (const row of pageRows) {
    row.peopleCount = peopleCounts.get(row.id) ?? 0;
  }

  if (filters.virtualColumns?.length) {
    const keys = filters.virtualColumns.map((c) => c.key);
    const values = await getCompanyEnrichmentValues(pageRows.map((r) => r.id), keys);
    for (const row of pageRows) {
      row.virtualColumnValues = values.get(row.id) ?? {};
    }
  }

  return {
    rows: pageRows,
    total,
    page,
    pageSize,
  };
}

/** Same filtered set as getCompanies, with no pagination — backs CSV export,
 * the Clay push, and bulk actions (reverify, clean-names) that must run over
 * every matching row, not just the rendered page. */
export async function getAllFilteredCompanies(
  filters: CompanyListFilters
): Promise<CompanyListRow[]> {
  return sortByLastUpdatedDesc(await fetchFilteredRows(filters)).map(toListRow);
}

/** Every column the list query omits, plus the raw enrichment blob. */
interface FullCompanyRow extends RawCompanyRow {
  description: string | null;
  founded_year: number | null;
  revenue: number | null;
  client: string | null;
  tags: string[] | null;
  domain_status: string | null;
  mx_provider: string | null;
  security_gateway: string | null;
  keywords: string[] | null;
  technologies: string[] | null;
  custom_data: Record<string, unknown> | null;
}

export interface CompanyExportRow {
  companyName: string | null;
  brandName: string | null;
  domain: string | null;
  websiteUrl: string | null;
  linkedinUrl: string | null;
  niche: string | null;
  industry: string | null;
  employeeCount: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  phoneType: string | null;
  phoneStatus: string | null;
  phoneVerifiedAt: string | null;
  email: string | null;
  emailStatus: string | null;
  emailVerifiedAt: string | null;
  description: string | null;
  foundedYear: number | null;
  revenue: number | null;
  client: string | null;
  sources: string[];
  qualityTier: string | null;
  domainStatus: string | null;
  mxProvider: string | null;
  securityGateway: string | null;
  keywords: string[];
  technologies: string[];
  tags: string[];
  lastUpdated: string | null;
  /** Enrichment fields (filtered custom_data), flattened into their own CSV
   * columns by the export layer. */
  customData: Record<string, unknown>;
}

/** Chunk size for the by-id `*` fetch — bounds both the id list in the query
 * string and each response (querying by primary key, a chunk returns at most
 * this many rows). */
const FULL_ROW_ID_CHUNK_SIZE = 200;
/** Cap on chunk queries in flight at once, so an unfiltered set (which can be
 * the whole table) doesn't fire hundreds of parallel requests. */
const FULL_ROW_FETCH_CONCURRENCY = 10;

/** Full `*` rows for a set of ids, chunked and fetched with bounded concurrency. */
async function fetchCompaniesByIds(ids: string[]): Promise<Map<string, FullCompanyRow>> {
  const byId = new Map<string, FullCompanyRow>();
  if (ids.length === 0) return byId;

  const chunks = chunkIds(ids, FULL_ROW_ID_CHUNK_SIZE);

  for (let i = 0; i < chunks.length; i += FULL_ROW_FETCH_CONCURRENCY) {
    const window = chunks.slice(i, i + FULL_ROW_FETCH_CONCURRENCY);
    const results = await Promise.all(
      window.map((chunk) => supabaseAdmin.from("companies").select("*").in("id", chunk))
    );
    for (const { data, error } of results) {
      if (error) throw error;
      for (const row of (data ?? []) as unknown as FullCompanyRow[]) {
        byId.set(row.id, row);
      }
    }
  }
  return byId;
}

/** Full-record fetch for CSV export and the Clay push. Resolves the matched
 * set cheaply (LIST_COLUMNS, filtered/sorted in Postgres), then pulls every
 * column (including custom_data) only for those ids — so it never fetches `*`
 * for the whole base table, which was slow enough to stall a push before the
 * first row went out. Returned already sorted, in the same order as the
 * list/export. */
async function fetchFullFilteredCompanies(
  filters: CompanyListFilters
): Promise<FullCompanyRow[]> {
  const matched = sortByLastUpdatedDesc(await fetchFilteredRows(filters));
  const ids = matched.map((row) => row.id);
  const byId = await fetchCompaniesByIds(ids);
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is FullCompanyRow => row != null);
}

function toExportRow(row: FullCompanyRow): CompanyExportRow {
  return {
    companyName: row.company_name,
    brandName: row.brand_name,
    domain: row.domain,
    websiteUrl: row.website_url,
    linkedinUrl: row.linkedin_url,
    niche: row.niche,
    industry: row.industry,
    employeeCount: row.employee_count,
    city: row.city,
    state: row.state,
    country: row.country,
    phone: row.phone,
    phoneType: row.phone_type,
    phoneStatus: row.phone_status,
    phoneVerifiedAt: row.phone_verified_at,
    email: row.email,
    emailStatus: row.email_status,
    emailVerifiedAt: row.email_verified_at,
    description: row.description,
    foundedYear: row.founded_year,
    revenue: row.revenue,
    client: row.client,
    sources: normalizeSourceTokens(row.source),
    qualityTier: row.quality_tier,
    domainStatus: row.domain_status,
    mxProvider: row.mx_provider,
    securityGateway: row.security_gateway,
    keywords: row.keywords ?? [],
    technologies: row.technologies ?? [],
    tags: row.tags ?? [],
    lastUpdated: row.last_updated,
    customData: toWebhookCustomData(row.custom_data),
  };
}

/** Full-record export: same filtered set as getAllFilteredCompanies but with
 * every native column and all enrichment (custom_data) keys retained. */
export async function getAllFilteredCompaniesForExport(
  filters: CompanyListFilters
): Promise<CompanyExportRow[]> {
  return (await fetchFullFilteredCompanies(filters)).map(toExportRow);
}

/** The full Clay webhook payload for one company: every native column plus each
 * enrichment (custom_data) key flattened to the top level. Enrichment is spread
 * first so native columns stay authoritative on any key collision. Keys are
 * snake_case to preserve the existing Clay field mapping; custom_data keys are
 * already snake_case, so they map cleanly too. Matches the CSV export's field
 * set and custom_data filtering. */
function toClayPayload(row: FullCompanyRow): Record<string, unknown> {
  return {
    ...toWebhookCustomData(row.custom_data),
    company_id: row.id,
    company_name: row.company_name,
    brand_name: row.brand_name,
    domain: row.domain,
    website_url: row.website_url,
    linkedin_url: row.linkedin_url,
    industry: row.industry,
    employee_count: row.employee_count,
    city: row.city,
    state: row.state,
    country: row.country,
    phone: row.phone,
    phone_type: row.phone_type,
    phone_status: row.phone_status,
    phone_verified_at: row.phone_verified_at,
    email: row.email,
    email_status: row.email_status,
    email_verified_at: row.email_verified_at,
    description: row.description,
    founded_year: row.founded_year,
    revenue: row.revenue,
    niche: row.niche,
    client: row.client,
    source: row.source,
    tags: row.tags,
    quality_tier: row.quality_tier,
    domain_status: row.domain_status,
    mx_provider: row.mx_provider,
    security_gateway: row.security_gateway,
    keywords: row.keywords,
    technologies: row.technologies,
    last_updated: row.last_updated,
  };
}

/** Clay push records for the current filtered view — the same set (and order)
 * as getAllFilteredCompanies, each carrying the full flattened webhook payload. */
export async function getCompaniesForClay(
  filters: CompanyListFilters
): Promise<ClayPushRecord[]> {
  const rows = await fetchFullFilteredCompanies(filters);
  return rows.map((row) => ({
    id: row.id,
    displayName: row.company_name,
    payload: toClayPayload(row),
  }));
}

interface FacetIdCount {
  id: string;
  count: number;
}

interface CompanyFilterOptionsRpcResult {
  niches: FacetIdCount[];
  sources: FacetIdCount[];
  industries: FacetIdCount[];
  countries: FacetIdCount[];
  emailStatuses: FacetIdCount[];
  phoneTypes: FacetIdCount[];
}

/** Serializes CompanyListFilters into the jsonb shape company_filter_options
 * (lib/data/canonical-columns.sql) expects. Employee buckets are resolved to
 * {min_v,max_v} ranges here (from the same EMPLOYEE_BUCKETS TypeScript
 * source of truth applyCompanyFilters/employeeBucketOrClause use) rather than
 * passing bucket ids for the RPC to interpret, so the bucket boundaries never
 * need to be duplicated in SQL. */
export function toFilterOptionsRpcPayload(filters: CompanyListFilters): Record<string, unknown> {
  const hasExplicitRange = filters.employeeMin != null || filters.employeeMax != null;
  return {
    search: filters.search ?? null,
    employeeMin: filters.employeeMin ?? null,
    employeeMax: filters.employeeMax ?? null,
    employeeBucketRanges: hasExplicitRange ? [] : employeeBucketRanges(filters.employeeBucket ?? []),
    email: filters.email ?? "any",
    phone: filters.phone ?? "any",
    niche: filters.niche ?? { include: [], exclude: [] },
    source: filters.source ?? { include: [], exclude: [] },
    industry: filters.industry ?? { include: [], exclude: [] },
    country: filters.country ?? { include: [], exclude: [] },
    emailStatus: filters.emailStatus ?? { include: [], exclude: [] },
    phoneType: filters.phoneType ?? { include: [], exclude: [] },
    virtualFilters: filters.virtualFilters ?? { combinator: "and", groups: [] },
    pushStatus: pushStatusRpcPayload(filters.pushStatus),
  };
}

function sortByCountDesc(a: { count: number }, b: { count: number }): number {
  return b.count - a.count;
}

/** Facet counts reflect the currently active filters, not the whole table —
 * e.g. narrowing to an Industry with 6k companies should make the Source
 * dropdown show source counts within that 6k, not the global total. Each
 * facet's own count excludes its own filter (so picking "Manual Csv" under
 * Source doesn't zero out every other source option), but is scoped by every
 * other active filter. All six dimensions are computed by a single Postgres
 * RPC (lib/data/canonical-columns.sql); labels are attached here from the
 * TypeScript alias tables (sourceLabel/industryLabel/countryLabel) so they
 * stay single-edit-point. */
export async function getCompanyFilterOptions(
  filters: CompanyListFilters = {}
): Promise<CompanyFilterOptions> {
  const { data, error } = await supabaseAdmin.rpc("company_filter_options", {
    filters: toFilterOptionsRpcPayload(filters),
  });
  if (error) throw error;
  const result = data as CompanyFilterOptionsRpcResult;

  return {
    niches: result.niches
      .map(({ id, count }) => ({ id, label: id, count }))
      .sort(sortByCountDesc),
    sources: result.sources
      .map(({ id, count }) => ({ id, label: sourceLabel(id), count }))
      .sort(sortByCountDesc),
    industries: result.industries
      .map(({ id, count }) => ({ id, label: industryLabel(id), count }))
      .sort(sortByCountDesc),
    countries: result.countries
      .map(({ id, count }) => ({ id, label: countryLabel(id), count }))
      .sort(sortByCountDesc),
    employeeBuckets: EMPLOYEE_BUCKETS.map((b) => ({ id: b.id, label: b.label })),
    emailStatuses: result.emailStatuses
      .map(({ id, count }) => ({ id, label: id, count }))
      .sort(sortByCountDesc),
    phoneTypes: result.phoneTypes
      .map(({ id, count }) => ({ id, label: id, count }))
      .sort(sortByCountDesc),
  };
}

/** Live per-status preview counts for the push-status popover (E1, issue #133).
 * Scoped by every *other* active filter (push status is self-excluded — the RPC
 * ignores the pushStatus key), then split into "not yet pushed" vs "already
 * pushed" for the selected client + platform, so `pushed + notPushed` equals the
 * total the filter would yield. Company "has work left" semantics: a company is
 * not-yet-pushed iff any linked person still needs pushing, already-pushed iff it
 * has people and none do (companies with no people count as neither). Backed by
 * company_push_status_counts (lib/data/push-status-counts.sql); mirrors
 * getPersonPushStatusCounts. */
export async function getCompanyPushStatusCounts(
  filters: CompanyListFilters,
  clientId: string,
  platform: PushPlatform
): Promise<PushStatusCounts> {
  const { data, error } = await supabaseAdmin.rpc("company_push_status_counts", {
    filters: toFilterOptionsRpcPayload(filters),
    client_id: clientId,
    platform,
  });
  if (error) throw error;
  const result = data as { pushed: number; notPushed: number };
  return { pushed: result.pushed, notPushed: result.notPushed };
}

export interface CompanyDetail {
  id: string;
  companyName: string | null;
  domain: string | null;
  websiteUrl: string | null;
  linkedinUrl: string | null;
  industry: string | null;
  employeeCount: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  phoneType: string | null;
  phoneStatus: string | null;
  phoneVerifiedAt: string | null;
  email: string | null;
  emailStatus: string | null;
  emailVerifiedAt: string | null;
  description: string | null;
  foundedYear: number | null;
  revenue: number | null;
  sources: string[];
  niche: string | null;
  client: string | null;
  tags: string[];
  lastUpdated: string | null;
  domainStatus: string | null;
  mxProvider: string | null;
  securityGateway: string | null;
  qualityTier: string | null;
  keywords: string[] | null;
  technologies: string[] | null;
  customData: Record<string, unknown>;
}

export async function getCompanyDetail(id: string): Promise<CompanyDetail | null> {
  const { data, error } = await supabaseAdmin
    .from("companies")
    .select("*")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  return {
    id: data.id,
    companyName: data.company_name,
    domain: data.domain,
    websiteUrl: data.website_url,
    linkedinUrl: data.linkedin_url,
    industry: data.industry,
    employeeCount: data.employee_count,
    city: data.city,
    state: data.state,
    country: data.country,
    phone: data.phone,
    phoneType: data.phone_type,
    phoneStatus: data.phone_status,
    phoneVerifiedAt: data.phone_verified_at,
    email: data.email,
    emailStatus: data.email_status,
    emailVerifiedAt: data.email_verified_at,
    description: data.description,
    foundedYear: data.founded_year,
    revenue: data.revenue,
    sources: normalizeSourceTokens(data.source),
    niche: data.niche,
    client: data.client,
    tags: data.tags ?? [],
    lastUpdated: data.last_updated,
    domainStatus: data.domain_status,
    mxProvider: data.mx_provider,
    securityGateway: data.security_gateway,
    qualityTier: data.quality_tier,
    keywords: data.keywords,
    technologies: data.technologies,
    customData: filterCustomData(data.custom_data),
  };
}

export { employeeBucketOf };
