import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/data/fetch-all-rows";
import { withTtlCache } from "@/lib/data/cache-with-ttl";
import { normalizeSourceTokens, sourceLabel } from "@/lib/data/source";
import { normalizeCountry } from "@/lib/data/country";
import { normalizeIndustry } from "@/lib/data/industry";
import { EMPLOYEE_BUCKETS, employeeBucketOf } from "@/lib/data/employee-size";
import { filterCustomData } from "@/lib/data/custom-data";
import { sortByLastUpdatedDesc } from "@/lib/data/sort";

export interface CompanyListFilters {
  search?: string;
  niche?: string[];
  source?: string[];
  industry?: string[];
  employeeBucket?: string[];
  country?: string[];
  employeeMin?: number;
  employeeMax?: number;
}

export interface CompanyListRow {
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
}

interface RawCompanyRow {
  id: string;
  company_name: string | null;
  domain: string | null;
  website_url: string | null;
  linkedin_url: string | null;
  industry: string | null;
  employee_count: number | null;
  city: string | null;
  state: string | null;
  country: string | null;
  phone: string | null;
  source: string | null;
  niche: string | null;
  quality_tier: string | null;
  last_updated: string | null;
}

const LIST_COLUMNS =
  "id,company_name,domain,website_url,linkedin_url,industry,employee_count,city,state,country,phone,source,niche,quality_tier,last_updated";

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

async function fetchBaseRowsUncached(filters: BaseFilters): Promise<RawCompanyRow[]> {
  const search = filters.search?.trim();

  return fetchAllRows<RawCompanyRow>("companies", LIST_COLUMNS, (query) => {
    let q = query;
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
  });
}

/** Cached the same way as the rest of this module's Supabase reads — see the
 * comment on fetchFilteredRows below. Keyed on the base filter subset only,
 * so requests that differ solely in niche/country/industry/source (which are
 * matched in-app) share the same cached fetch. */
const fetchBaseRows = withTtlCache(fetchBaseRowsUncached, 3_600_000);

function matchesNiche(row: RawCompanyRow, filters: CompanyListFilters): boolean {
  return !filters.niche?.length || (row.niche != null && filters.niche.includes(row.niche));
}

function matchesCountry(row: RawCompanyRow, filters: CompanyListFilters): boolean {
  if (!filters.country?.length) return true;
  const country = normalizeCountry(row.country);
  return Boolean(country && filters.country.includes(country.id));
}

function matchesIndustry(row: RawCompanyRow, filters: CompanyListFilters): boolean {
  if (!filters.industry?.length) return true;
  const industry = normalizeIndustry(row.industry);
  return Boolean(industry && filters.industry.includes(industry.id));
}

function matchesSource(row: RawCompanyRow, filters: CompanyListFilters): boolean {
  if (!filters.source?.length) return true;
  const tokens = normalizeSourceTokens(row.source);
  return tokens.some((t) => filters.source!.includes(t));
}

/** Deliberately calls fetchBaseRowsUncached (not the cached fetchBaseRows)
 * here: fetchBaseRows's cache key excludes niche/country/industry/source
 * (see the comment above it), so routing this path through it would let two
 * requests that only differ by e.g. niche collide on the same cache entry —
 * one request's fetch (and its cached snapshot) would silently answer for
 * the other's rows, including rows that didn't exist yet when that snapshot
 * was taken. fetchFilteredRows below is keyed on the *full* filters object,
 * which already includes niche/country/industry/source, so caching still
 * happens — just at this function's boundary instead of one layer down. */
async function fetchFilteredRowsUncached(filters: CompanyListFilters): Promise<RawCompanyRow[]> {
  const rows = await fetchBaseRowsUncached(toBaseFilters(filters));
  return rows.filter(
    (row) =>
      matchesNiche(row, filters) &&
      matchesCountry(row, filters) &&
      matchesIndustry(row, filters) &&
      matchesSource(row, filters)
  );
}

/** The companies table is ~29k rows; fetching and re-filtering all of it from
 * Supabase on every request (this page is force-dynamic) is the dominant cost
 * on /companies. Data here is synced in batches (see the "Synced ... UTC"
 * stamp in the UI), not edited live, so a cross-request cache trades a little
 * staleness for skipping that full-table round trip on every view. TTL
 * matches the page's own `revalidate = 3600`, since that's the staleness
 * window already accepted at the page level. */
const fetchFilteredRows = withTtlCache(fetchFilteredRowsUncached, 3_600_000);

function toListRow(row: RawCompanyRow): CompanyListRow {
  return {
    id: row.id,
    companyName: row.company_name,
    domain: row.domain,
    websiteUrl: row.website_url,
    linkedinUrl: row.linkedin_url,
    industry: row.industry,
    employeeCount: row.employee_count,
    city: row.city,
    state: row.state,
    country: row.country,
    phone: row.phone,
    niche: row.niche,
    sources: normalizeSourceTokens(row.source),
    qualityTier: row.quality_tier,
    lastUpdated: row.last_updated,
  };
}

/** Ids per `.in()` chunk when querying people-by-company below. Keeps each
 * request's query string (and the HEAD count query fetchAllRows issues
 * first) comfortably under URL length limits — a single `.in()` clause built
 * from ~1000 UUIDs (e.g. an export-sized page) was long enough to fail the
 * request outright. */
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

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += PEOPLE_COUNT_ID_CHUNK_SIZE) {
    chunks.push(ids.slice(i, i + PEOPLE_COUNT_ID_CHUNK_SIZE));
  }

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

export async function getCompanies(
  filters: CompanyListFilters,
  page = 1,
  pageSize = 50
): Promise<CompanyListResult> {
  const rows = sortByLastUpdatedDesc(await fetchFilteredRows(filters));
  const start = (page - 1) * pageSize;
  const pageRows = rows.slice(start, start + pageSize).map(toListRow);

  const peopleCounts = await getPeopleCountsForCompanies(pageRows.map((r) => r.id));
  for (const row of pageRows) {
    row.peopleCount = peopleCounts.get(row.id) ?? 0;
  }

  return {
    rows: pageRows,
    total: rows.length,
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

/** Facet counts reflect the currently active filters, not the whole table —
 * e.g. narrowing to an Industry with 6k companies should make the Source
 * dropdown show source counts within that 6k, not the global total. Each
 * facet's own count excludes its own filter (so picking "Manual Csv" under
 * Source doesn't zero out every other source option), but is scoped by every
 * other active filter. */
export async function getCompanyFilterOptions(
  filters: CompanyListFilters = {}
): Promise<CompanyFilterOptions> {
  const rows = await fetchBaseRows(toBaseFilters(filters));

  const niches = new Map<string, number>();
  const sources = new Map<string, number>();
  const industries = new Map<string, { label: string; count: number }>();
  const countries = new Map<string, { label: string; count: number }>();

  for (const row of rows) {
    const okCountry = matchesCountry(row, filters);
    const okIndustry = matchesIndustry(row, filters);
    const okSource = matchesSource(row, filters);
    const okNiche = matchesNiche(row, filters);

    if (okCountry && okIndustry && okSource && row.niche) {
      niches.set(row.niche, (niches.get(row.niche) ?? 0) + 1);
    }

    if (okNiche && okCountry && okIndustry) {
      for (const token of normalizeSourceTokens(row.source)) {
        sources.set(token, (sources.get(token) ?? 0) + 1);
      }
    }

    if (okNiche && okCountry && okSource) {
      const industry = normalizeIndustry(row.industry);
      if (industry) {
        const existing = industries.get(industry.id);
        industries.set(industry.id, { label: industry.label, count: (existing?.count ?? 0) + 1 });
      }
    }

    if (okNiche && okIndustry && okSource) {
      const country = normalizeCountry(row.country);
      if (country) {
        const existing = countries.get(country.id);
        countries.set(country.id, { label: country.label, count: (existing?.count ?? 0) + 1 });
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
