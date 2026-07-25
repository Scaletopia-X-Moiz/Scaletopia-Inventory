import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/data/fetch-all-rows";
import { normalizeSourceTokens, sourceLabel } from "@/lib/data/source";
import { normalizeCountry } from "@/lib/data/country";
import { normalizeIndustry } from "@/lib/data/industry";
import { EMPLOYEE_BUCKETS, employeeBucketOf } from "@/lib/data/employee-size";
import { filterCustomData, toWebhookCustomData } from "@/lib/data/custom-data";
import { sortByLastUpdatedDesc } from "@/lib/data/sort";
import type { ClayPushRecord } from "@/lib/clay/types";
import { matchesIncludeExclude, type IncludeExclude } from "@/lib/data/include-exclude";

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

/** The only columns the full-table scan actually needs to filter, facet, and
 * sort the companies list. Every filter that reaches the scan (niche, country,
 * industry, source, employee size, email/phone presence + status) reads one of
 * these; sorting needs id + last_updated. The wide display-only columns
 * (company_name, brand_name, domain, website_url, linkedin_url, city, state,
 * phone_status, verified_at, quality_tier) are dropped here and refetched by id
 * only for the ~50 rows actually shown — see getCompanies. On an ~87k-row table
 * this roughly halves the per-request payload (the widest text columns are the
 * dropped ones) without changing any caching semantics. */
const FILTER_COLUMNS =
  "id,niche,industry,source,country,employee_count,email,phone,email_status,phone_type,last_updated";

/** Narrow row from the FILTER_COLUMNS scan — enough to filter, facet, and sort,
 * but not to render a table row (that needs the display columns refetched by
 * id). RawCompanyRow is a structural superset, so the shared matchers and
 * filterCompanyRows work over either. */
interface FilterCompanyRow {
  id: string;
  niche: string | null;
  industry: string | null;
  source: string | null;
  country: string | null;
  employee_count: number | null;
  email: string | null;
  phone: string | null;
  email_status: string | null;
  phone_type: string | null;
  last_updated: string | null;
}

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

/** Subset of CompanyListFilters that maps cleanly onto Postgres/PostgREST
 * (search, employee buckets — native columns with no casing/synonym mess).
 * Niche/Country/Industry/Source raw values have synonyms or casing variants
 * the DB doesn't normalize, so they're matched in-app instead — which also
 * lets facet counts be computed by excluding one filter at a time (see
 * getCompanyFilterOptions) without re-querying Postgres per facet. */
type BaseFilters = Pick<CompanyListFilters, "search" | "employeeMin" | "employeeMax" | "employeeBucket">;

function toBaseFilters(filters: CompanyListFilters): BaseFilters {
  return {
    search: filters.search,
    employeeMin: filters.employeeMin,
    employeeMax: filters.employeeMax,
    employeeBucket: filters.employeeBucket,
  };
}

/** Applies the base (DB-level) filters shared by the list query and the full
 * export query, so both narrow the companies table identically before the
 * in-app niche/country/industry/source pass. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyCompanyBaseFilters(query: any, filters: BaseFilters): any {
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
  return q;
}

async function fetchBaseRowsUncached(filters: BaseFilters): Promise<RawCompanyRow[]> {
  return fetchAllRows<RawCompanyRow>("companies", LIST_COLUMNS, (query) =>
    applyCompanyBaseFilters(query, filters)
  );
}

/** The hot-path base scan: same filtered set as fetchBaseRowsUncached but pulling
 * only FILTER_COLUMNS. Backs the rendered list page (getCompanies) and its facets
 * (getCompanyFilterOptions) — the two queries that fire on every page load,
 * pagination click, and filter change. */
async function fetchFilterBaseRows(filters: BaseFilters): Promise<FilterCompanyRow[]> {
  return fetchAllRows<FilterCompanyRow>("companies", FILTER_COLUMNS, (query) =>
    applyCompanyBaseFilters(query, filters)
  );
}

/** Caching disabled for now — a per-process TTL cache (globalThis Map) was
 * serving stale brand_name/email_status/etc. after writes on multi-instance
 * deployments, since invalidateCompaniesListCache() only clears the instance
 * that handled the write, not the one that serves the next read. Revisit with
 * a shared cache (Redis, or a Next cacheHandler) if the full-table read here
 * becomes a bottleneck again. */
const fetchBaseRows = fetchBaseRowsUncached;

function matchesNiche(row: FilterCompanyRow, filters: CompanyListFilters): boolean {
  return matchesIncludeExclude(row.niche != null ? [row.niche] : [], filters.niche);
}

function matchesCountry(row: FilterCompanyRow, filters: CompanyListFilters): boolean {
  const country = normalizeCountry(row.country);
  return matchesIncludeExclude(country ? [country.id] : [], filters.country);
}

function matchesIndustry(row: FilterCompanyRow, filters: CompanyListFilters): boolean {
  const industry = normalizeIndustry(row.industry);
  return matchesIncludeExclude(industry ? [industry.id] : [], filters.industry);
}

function matchesSource(row: FilterCompanyRow, filters: CompanyListFilters): boolean {
  return matchesIncludeExclude(normalizeSourceTokens(row.source), filters.source);
}

function matchesEmailPresence(row: FilterCompanyRow, filters: CompanyListFilters): boolean {
  if (filters.email === "not_empty" && !row.email) return false;
  if (filters.email === "empty" && row.email) return false;
  return true;
}

function matchesPhonePresence(row: FilterCompanyRow, filters: CompanyListFilters): boolean {
  if (filters.phone === "not_empty" && !row.phone) return false;
  if (filters.phone === "empty" && row.phone) return false;
  return true;
}

function matchesEmailStatus(row: FilterCompanyRow, filters: CompanyListFilters): boolean {
  return matchesIncludeExclude(row.email_status != null ? [row.email_status] : [], filters.emailStatus);
}

function matchesPhoneType(row: FilterCompanyRow, filters: CompanyListFilters): boolean {
  return matchesIncludeExclude(row.phone_type != null ? [row.phone_type] : [], filters.phoneType);
}

/** Routes through the cached fetchBaseRows (keyed on the base filter subset),
 * then applies niche/country/industry/source in-app. The base rows are
 * filter-independent of those four facets — they're stripped by toBaseFilters
 * before the DB query — so two requests that differ only by e.g. niche pull
 * the *same* base set and are correctly narrowed afterward in JS. Sharing that
 * one base fetch is exactly what getCompanyFilterOptions below also does, so
 * loading /companies (list + facets, fired concurrently) now pays for one
 * full-table read instead of two. Any staleness is bounded by the same TTL the
 * page's `revalidate` already accepts (matches lib/data/people.ts). */
/** The niche/country/industry/source pass shared by every consumer of the base
 * rows, cached or not. */
function filterCompanyRows<T extends FilterCompanyRow>(
  rows: T[],
  filters: CompanyListFilters
): T[] {
  return rows.filter(
    (row) =>
      matchesNiche(row, filters) &&
      matchesCountry(row, filters) &&
      matchesIndustry(row, filters) &&
      matchesSource(row, filters) &&
      matchesEmailPresence(row, filters) &&
      matchesPhonePresence(row, filters) &&
      matchesEmailStatus(row, filters) &&
      matchesPhoneType(row, filters)
  );
}

async function fetchFilteredRowsUncached(filters: CompanyListFilters): Promise<RawCompanyRow[]> {
  const rows = await fetchBaseRows(toBaseFilters(filters));
  return filterCompanyRows(rows, filters);
}

/** The companies table is ~87k rows (and growing); fetching and re-filtering
 * all of it from Supabase on every request (this page is force-dynamic) is the
 * dominant cost on /companies — a full read is ~40 MB / several seconds.
 * Caching is disabled for now (see fetchBaseRows above) since it was serving
 * stale writes across instances; reintroduce with a shared cache if this
 * full-table read becomes a bottleneck. */
const fetchFilteredRows = fetchFilteredRowsUncached;

/** No-op now that fetchBaseRows/fetchFilteredRows read fresh every time — kept
 * so callers (clean-names, reverify, reverify-phone) don't need touching if
 * caching comes back. */
export function invalidateCompaniesListCache(): void {}

/** Same filtering as fetchFilteredRows, but reads the base rows fresh instead
 * of through the hour-long TTL cache. The list page can tolerate that
 * staleness window (see above), but the full-record path below backs CSV
 * export and the Clay push — actions users trigger right after a CSV import
 * expecting the rows they just added to be included. Going through the cached
 * base rows would silently drop anything inserted since the last cache fill,
 * for up to an hour. */
async function fetchFilteredRowsFresh(filters: CompanyListFilters): Promise<RawCompanyRow[]> {
  const rows = await fetchBaseRowsUncached(toBaseFilters(filters));
  return filterCompanyRows(rows, filters);
}

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

/** Ids per `.in()` chunk when refetching display columns for the current page.
 * Keeps each query string under URL length limits when getCompanies is called
 * with a large pageSize (e.g. the 1000-row pages the tests exercise). */
const DISPLAY_ROW_ID_CHUNK_SIZE = 100;

/** Display (LIST_COLUMNS) rows for a set of ids, chunked. Ordering is
 * re-imposed by the caller from the id list, so this returns a lookup map
 * rather than an ordered array. The chunk fan-out is unbounded because the id
 * set is only ever the current page (≤ pageSize) — unlike fetchCompaniesByIds,
 * which caps concurrency precisely because its set can be the whole table. */
async function fetchCompanyDisplayRowsByIds(ids: string[]): Promise<Map<string, RawCompanyRow>> {
  const byId = new Map<string, RawCompanyRow>();
  if (ids.length === 0) return byId;

  const chunks = chunkIds(ids, DISPLAY_ROW_ID_CHUNK_SIZE);

  const results = await Promise.all(
    chunks.map((chunk) =>
      supabaseAdmin.from("companies").select(LIST_COLUMNS).in("id", chunk)
    )
  );
  for (const { data, error } of results) {
    if (error) throw error;
    for (const row of (data ?? []) as unknown as RawCompanyRow[]) {
      byId.set(row.id, row);
    }
  }
  return byId;
}

export async function getCompanies(
  filters: CompanyListFilters,
  page = 1,
  pageSize = 50
): Promise<CompanyListResult> {
  // Scan only the narrow filter columns for the whole table, then refetch the
  // wide display columns for just the current page's ids (see FILTER_COLUMNS).
  const baseRows = await fetchFilterBaseRows(toBaseFilters(filters));
  const filtered = sortByLastUpdatedDesc(filterCompanyRows(baseRows, filters));
  const start = (page - 1) * pageSize;
  const pageIds = filtered.slice(start, start + pageSize).map((r) => r.id);

  const [displayById, peopleCounts] = await Promise.all([
    fetchCompanyDisplayRowsByIds(pageIds),
    getPeopleCountsForCompanies(pageIds),
  ]);

  const pageRows = pageIds
    .map((id) => displayById.get(id))
    .filter((row): row is RawCompanyRow => row != null)
    .map(toListRow);
  for (const row of pageRows) {
    row.peopleCount = peopleCounts.get(row.id) ?? 0;
  }

  return {
    rows: pageRows,
    total: filtered.length,
    page,
    pageSize,
  };
}

/** Same query + filtering as getCompanies, with no pagination — the export
 * function must run through the identical filtered query, not a separate path. */
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

/** Full-record fetch for CSV export and the Clay push. Resolves the matched set
 * cheaply (id/niche/etc. columns only, and reading the base rows fresh rather
 * than through the list page's TTL cache — see fetchFilteredRowsFresh), then
 * pulls every column (including custom_data) only for those ids — so it never
 * fetches `*` for the whole base table, which was slow enough to stall a push
 * before the first row went out. Returned already sorted, in the same order as
 * the list/export. */
async function fetchFullFilteredCompanies(
  filters: CompanyListFilters
): Promise<FullCompanyRow[]> {
  const matched = sortByLastUpdatedDesc(await fetchFilteredRowsFresh(filters));
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

/** Facet counts reflect the currently active filters, not the whole table —
 * e.g. narrowing to an Industry with 6k companies should make the Source
 * dropdown show source counts within that 6k, not the global total. Each
 * facet's own count excludes its own filter (so picking "Manual Csv" under
 * Source doesn't zero out every other source option), but is scoped by every
 * other active filter. */
export async function getCompanyFilterOptions(
  filters: CompanyListFilters = {}
): Promise<CompanyFilterOptions> {
  // Facets read only filter columns, so the narrow scan is enough here too.
  const rows = await fetchFilterBaseRows(toBaseFilters(filters));

  const niches = new Map<string, number>();
  const sources = new Map<string, number>();
  const industries = new Map<string, { label: string; count: number }>();
  const countries = new Map<string, { label: string; count: number }>();
  const emailStatuses = new Map<string, number>();
  const phoneTypes = new Map<string, number>();

  for (const row of rows) {
    const okCommon = matchesEmailPresence(row, filters) && matchesPhonePresence(row, filters);
    if (!okCommon) continue;

    const okCountry = matchesCountry(row, filters);
    const okIndustry = matchesIndustry(row, filters);
    const okSource = matchesSource(row, filters);
    const okNiche = matchesNiche(row, filters);
    const okEmailStatus = matchesEmailStatus(row, filters);
    const okPhoneType = matchesPhoneType(row, filters);

    if (okCountry && okIndustry && okSource && okEmailStatus && okPhoneType && row.niche) {
      niches.set(row.niche, (niches.get(row.niche) ?? 0) + 1);
    }

    if (okNiche && okCountry && okIndustry && okEmailStatus && okPhoneType) {
      for (const token of normalizeSourceTokens(row.source)) {
        sources.set(token, (sources.get(token) ?? 0) + 1);
      }
    }

    if (okNiche && okCountry && okSource && okEmailStatus && okPhoneType) {
      const industry = normalizeIndustry(row.industry);
      if (industry) {
        const existing = industries.get(industry.id);
        industries.set(industry.id, { label: industry.label, count: (existing?.count ?? 0) + 1 });
      }
    }

    if (okNiche && okIndustry && okSource && okEmailStatus && okPhoneType) {
      const country = normalizeCountry(row.country);
      if (country) {
        const existing = countries.get(country.id);
        countries.set(country.id, { label: country.label, count: (existing?.count ?? 0) + 1 });
      }
    }

    if (okNiche && okCountry && okIndustry && okSource && okPhoneType) {
      if (row.email_status) {
        emailStatuses.set(row.email_status, (emailStatuses.get(row.email_status) ?? 0) + 1);
      }
    }

    if (okNiche && okCountry && okIndustry && okSource && okEmailStatus) {
      if (row.phone_type) {
        phoneTypes.set(row.phone_type, (phoneTypes.get(row.phone_type) ?? 0) + 1);
      }
    }
  }

  const sortDesc = <T extends { count: number }>(a: T, b: T) => b.count - a.count;

  return {
    niches: Array.from(niches.entries())
      .map(([id, count]) => ({ id, label: id, count }))
      .sort(sortDesc),
    sources: Array.from(sources.entries())
      .map(([id, count]) => ({ id, label: sourceLabel(id), count }))
      .sort(sortDesc),
    industries: Array.from(industries.entries())
      .map(([id, { label, count }]) => ({ id, label, count }))
      .sort(sortDesc),
    countries: Array.from(countries.entries())
      .map(([id, { label, count }]) => ({ id, label, count }))
      .sort(sortDesc),
    employeeBuckets: EMPLOYEE_BUCKETS.map((b) => ({ id: b.id, label: b.label })),
    emailStatuses: Array.from(emailStatuses.entries())
      .map(([id, count]) => ({ id, label: id, count }))
      .sort(sortDesc),
    phoneTypes: Array.from(phoneTypes.entries())
      .map(([id, count]) => ({ id, label: id, count }))
      .sort(sortDesc),
  };
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
