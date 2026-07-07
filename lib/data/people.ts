import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/data/fetch-all-rows";
import { withTtlCache, invalidateTtlCache } from "@/lib/data/cache-with-ttl";
import { normalizeSourceTokens, sourceLabel } from "@/lib/data/source";
import { normalizeCountry } from "@/lib/data/country";
import { normalizeIndustry } from "@/lib/data/industry";
import { EMPLOYEE_BUCKETS, employeeBucketOf } from "@/lib/data/employee-size";
import { filterCustomData, toWebhookCustomData } from "@/lib/data/custom-data";
import { nichesFromTags } from "@/lib/data/niche";
import { sortByLastUpdatedDesc } from "@/lib/data/sort";
import type { ClayPushRecord } from "@/lib/clay/types";
import { matchesIncludeExclude, type IncludeExclude } from "@/lib/data/include-exclude";

export type SingleSelectFilter = "any" | "not_empty" | "empty";

export interface PersonListFilters {
  search?: string;
  niche?: IncludeExclude;
  source?: IncludeExclude;
  country?: IncludeExclude;
  employeeBucket?: string[];
  industry?: IncludeExclude;
  email?: SingleSelectFilter;
  phone?: SingleSelectFilter;
  emailStatus?: IncludeExclude;
  phoneType?: IncludeExclude;
  jobTitle?: string;
  employeeMin?: number;
  employeeMax?: number;
}

export interface PersonListRow {
  id: string;
  fullName: string | null;
  jobTitle: string | null;
  email: string | null;
  emailStatus: string | null;
  emailVerifiedAt: string | null;
  phone: string | null;
  phoneType: string | null;
  phoneStatus: string | null;
  phoneVerifiedAt: string | null;
  linkedinUrl: string | null;
  companyId: string | null;
  companyName: string | null;
  domain: string | null;
  companyLinkedinUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  sources: string[];
  lastUpdated: string | null;
}

export interface PersonListResult {
  rows: PersonListRow[];
  total: number;
  page: number;
  pageSize: number;
}

export interface FilterOption {
  id: string;
  label: string;
  count: number;
}

export interface PersonFilterOptions {
  niches: FilterOption[];
  sources: FilterOption[];
  countries: FilterOption[];
  industries: FilterOption[];
  employeeBuckets: { id: string; label: string }[];
  emailStatuses: FilterOption[];
  phoneTypes: FilterOption[];
}

interface RawPersonRow {
  id: string;
  company_id: string | null;
  full_name: string | null;
  job_title: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  domain: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  source: string | null;
  tags: string[] | null;
  last_updated: string | null;
  email_status: string | null;
  email_verified_at: string | null;
  phone_type: string | null;
  phone_status: string | null;
  phone_verified_at: string | null;
  company_name: string | null;
}

const LIST_COLUMNS =
  "id,company_id,full_name,job_title,email,phone,linkedin_url,domain,city,state,country,source,tags,last_updated,email_status,email_verified_at,phone_type,phone_status,phone_verified_at,company_name";

interface LinkedCompanyJoinRow {
  niche: string | null;
  employee_count: number | null;
  industry: string | null;
  linkedin_url: string | null;
}

interface CompanyJoinData {
  byId: Map<string, LinkedCompanyJoinRow>;
  knownClients: Set<string>;
}

/** The companies table is ~87k rows; both getPeople and getPersonFilterOptions
 * need this join per request, and it's identical across requests until the
 * next sync, so it's cached the same way as the companies filter-option rows
 * (see companies.ts) rather than re-fetched from Supabase every time. The
 * stable cacheKey lets the store persist across dev recompiles. TTL matches
 * the page's own `revalidate = 3600`. */
const fetchCompanyJoinRows = withTtlCache(
  () =>
    fetchAllRows<{
      id: string;
      niche: string | null;
      employee_count: number | null;
      industry: string | null;
      client: string | null;
      linkedin_url: string | null;
    }>("companies", "id,niche,employee_count,industry,client,linkedin_url"),
  3_600_000,
  "people:companyJoin"
);

/** Companies have native niche/employee_count/industry columns people lack on
 * their own row, so Employee Size, Industry, and (when the linked company's
 * niche is empty) Niche all need this join. `knownClients` — derived from
 * `client` rather than an external list — backs the tag-parsing niche
 * fallback in `niche.ts`. */
async function loadCompanyJoinData(): Promise<CompanyJoinData> {
  const rows = await fetchCompanyJoinRows();

  const byId = new Map<string, LinkedCompanyJoinRow>();
  const knownClients = new Set<string>();
  for (const row of rows) {
    byId.set(row.id, {
      niche: row.niche,
      employee_count: row.employee_count,
      industry: row.industry,
      linkedin_url: row.linkedin_url,
    });
    if (row.client) knownClients.add(row.client.trim().toLowerCase());
  }
  return { byId, knownClients };
}

function personNiches(
  row: { tags: string[] | null },
  company: LinkedCompanyJoinRow | undefined,
  knownClients: ReadonlySet<string>
): string[] {
  if (company?.niche) return [company.niche];
  return nichesFromTags(row.tags, knownClients);
}

function jobTitleTerms(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean);
}

/** Only `search` maps cleanly onto a cheap, cacheable PostgREST query.
 * Everything else — including email_status/phone_type, which used to run as
 * DB-level `.in()` filters — is matched in-app instead. That's what lets
 * getPersonFilterOptions compute facet counts by excluding one filter at a
 * time (e.g. Source counts scoped to the active Industry filter, without the
 * Source filter itself collapsing every other source to zero). */
type BaseFilters = Pick<PersonListFilters, "search">;

function toBaseFilters(filters: PersonListFilters): BaseFilters {
  return { search: filters.search };
}

async function fetchBaseRowsUncached(filters: BaseFilters): Promise<RawPersonRow[]> {
  const search = filters.search?.trim();

  return fetchAllRows<RawPersonRow>("people", LIST_COLUMNS, (query) => {
    let q = query;
    if (search) {
      const term = search.replace(/[%,]/g, "");
      q = q.or(`full_name.ilike.%${term}%,email.ilike.%${term}%`);
    }
    return q;
  });
}

/** Re-fetching and re-filtering the whole people table from Supabase on every
 * request (this page is force-dynamic) is the dominant cost on /people, same
 * as companies.ts. Cached per unique search term — see the companies.ts
 * comment for why a TTL matching the page's `revalidate` window is safe for
 * this synced-in-batches dataset. The stable cacheKey persists the store
 * across dev recompiles. */
const fetchBaseRows = withTtlCache(fetchBaseRowsUncached, 3_600_000, "people:base");

/** Drops the cached table read so the next list request sees fresh data
 * immediately, instead of waiting out the hour-long TTL. Called after a
 * reverify writes email_status/email_verified_at directly via Supabase,
 * bypassing this cache — without it, that write stays invisible here until
 * the TTL expires (or the dev server restarts, which clears globalThis). */
export function invalidatePeopleListCache(): void {
  invalidateTtlCache("people:base");
}

function matchesEmailPresence(row: RawPersonRow, filters: PersonListFilters): boolean {
  if (filters.email === "not_empty" && !row.email) return false;
  if (filters.email === "empty" && row.email) return false;
  return true;
}

function matchesPhonePresence(row: RawPersonRow, filters: PersonListFilters): boolean {
  if (filters.phone === "not_empty" && !row.phone) return false;
  if (filters.phone === "empty" && row.phone) return false;
  return true;
}

function matchesJobTitle(row: RawPersonRow, filters: PersonListFilters): boolean {
  const titleTerms = jobTitleTerms(filters.jobTitle);
  if (!titleTerms.length) return true;
  const title = row.job_title?.toLowerCase() ?? "";
  return titleTerms.some((t) => title.includes(t));
}

function matchesCountry(row: RawPersonRow, filters: PersonListFilters): boolean {
  const country = normalizeCountry(row.country);
  return matchesIncludeExclude(country ? [country.id] : [], filters.country);
}

function matchesSource(row: RawPersonRow, filters: PersonListFilters): boolean {
  return matchesIncludeExclude(normalizeSourceTokens(row.source), filters.source);
}

function matchesEmailStatus(row: RawPersonRow, filters: PersonListFilters): boolean {
  return matchesIncludeExclude(row.email_status != null ? [row.email_status] : [], filters.emailStatus);
}

function matchesPhoneType(row: RawPersonRow, filters: PersonListFilters): boolean {
  return matchesIncludeExclude(row.phone_type != null ? [row.phone_type] : [], filters.phoneType);
}

function matchesIndustry(
  company: LinkedCompanyJoinRow | undefined,
  filters: PersonListFilters
): boolean {
  const industry = normalizeIndustry(company?.industry);
  return matchesIncludeExclude(industry ? [industry.id] : [], filters.industry);
}

function matchesEmployeeSize(
  company: LinkedCompanyJoinRow | undefined,
  filters: PersonListFilters
): boolean {
  if (filters.employeeMin != null || filters.employeeMax != null) {
    const count = company?.employee_count ?? null;
    if (count == null) return false;
    if (filters.employeeMin != null && count < filters.employeeMin) return false;
    if (filters.employeeMax != null && count > filters.employeeMax) return false;
    return true;
  }
  if (filters.employeeBucket?.length) {
    const bucket = employeeBucketOf(company?.employee_count);
    return Boolean(bucket && filters.employeeBucket.includes(bucket.id));
  }
  return true;
}

function matchesNiche(
  row: RawPersonRow,
  company: LinkedCompanyJoinRow | undefined,
  knownClients: ReadonlySet<string>,
  filters: PersonListFilters
): boolean {
  const niches = personNiches(row, company, knownClients);
  return matchesIncludeExclude(niches, filters.niche);
}

async function fetchFilteredRowsUncached(
  filters: PersonListFilters,
  companyData: CompanyJoinData
): Promise<RawPersonRow[]> {
  const rows = await fetchBaseRows(toBaseFilters(filters));

  return rows.filter((row) => {
    const company = row.company_id ? companyData.byId.get(row.company_id) : undefined;
    return (
      matchesEmailPresence(row, filters) &&
      matchesPhonePresence(row, filters) &&
      matchesJobTitle(row, filters) &&
      matchesCountry(row, filters) &&
      matchesSource(row, filters) &&
      matchesEmailStatus(row, filters) &&
      matchesPhoneType(row, filters) &&
      matchesIndustry(company, filters) &&
      matchesEmployeeSize(company, filters) &&
      matchesNiche(row, company, companyData.knownClients, filters)
    );
  });
}

function toListRow(row: RawPersonRow, companyData: CompanyJoinData): PersonListRow {
  const company = row.company_id ? companyData.byId.get(row.company_id) : undefined;
  return {
    id: row.id,
    fullName: row.full_name,
    jobTitle: row.job_title,
    email: row.email,
    emailStatus: row.email_status,
    emailVerifiedAt: row.email_verified_at,
    phone: row.phone,
    phoneType: row.phone_type,
    phoneStatus: row.phone_status,
    phoneVerifiedAt: row.phone_verified_at,
    linkedinUrl: row.linkedin_url,
    companyId: row.company_id,
    companyName: row.company_name,
    domain: row.domain,
    companyLinkedinUrl: company?.linkedin_url ?? null,
    city: row.city,
    state: row.state,
    country: row.country,
    sources: normalizeSourceTokens(row.source),
    lastUpdated: row.last_updated,
  };
}

export async function getPeople(
  filters: PersonListFilters,
  page = 1,
  pageSize = 50
): Promise<PersonListResult> {
  const companyData = await loadCompanyJoinData();
  const candidateRows = await fetchFilteredRowsUncached(filters, companyData);
  const rows = sortByLastUpdatedDesc(candidateRows);
  const start = (page - 1) * pageSize;
  return {
    rows: rows.slice(start, start + pageSize).map((row) => toListRow(row, companyData)),
    total: rows.length,
    page,
    pageSize,
  };
}

/** Same query + filtering as getPeople, with no pagination — the export
 * function must run through the identical filtered query, not a separate path. */
export async function getAllFilteredPeople(filters: PersonListFilters): Promise<PersonListRow[]> {
  const companyData = await loadCompanyJoinData();
  const candidateRows = await fetchFilteredRowsUncached(filters, companyData);
  return sortByLastUpdatedDesc(candidateRows).map((row) => toListRow(row, companyData));
}

/** The raw person row plus the enrichment blob and identity columns the list query drops. */
interface FullPersonRow extends RawPersonRow {
  first_name: string | null;
  last_name: string | null;
  source_id: string | null;
  linkedin_username: string | null;
  custom_data: Record<string, unknown> | null;
}

export interface PersonExportRow {
  firstName: string | null;
  lastName: string | null;
  fullName: string | null;
  jobTitle: string | null;
  email: string | null;
  emailStatus: string | null;
  emailVerifiedAt: string | null;
  phone: string | null;
  phoneType: string | null;
  phoneStatus: string | null;
  phoneVerifiedAt: string | null;
  linkedinUrl: string | null;
  linkedinUsername: string | null;
  companyName: string | null;
  domain: string | null;
  companyLinkedinUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  sourceId: string | null;
  sources: string[];
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
async function fetchPeopleByIds(ids: string[]): Promise<Map<string, FullPersonRow>> {
  const byId = new Map<string, FullPersonRow>();
  if (ids.length === 0) return byId;

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += FULL_ROW_ID_CHUNK_SIZE) {
    chunks.push(ids.slice(i, i + FULL_ROW_ID_CHUNK_SIZE));
  }

  for (let i = 0; i < chunks.length; i += FULL_ROW_FETCH_CONCURRENCY) {
    const window = chunks.slice(i, i + FULL_ROW_FETCH_CONCURRENCY);
    const results = await Promise.all(
      window.map((chunk) => supabaseAdmin.from("people").select("*").in("id", chunk))
    );
    for (const { data, error } of results) {
      if (error) throw error;
      for (const row of (data ?? []) as unknown as FullPersonRow[]) {
        byId.set(row.id, row);
      }
    }
  }
  return byId;
}

/** Full-record fetch for CSV export and the Clay push. Resolves the matched set
 * cheaply through the cached list query, then pulls every column (including
 * custom_data) only for those ids — so it never fetches `*` for the whole
 * people table, which was slow enough to stall a push before the first row went
 * out. Returned already sorted, in the same order as the list/export. */
async function fetchFullFilteredPeople(
  filters: PersonListFilters,
  companyData: CompanyJoinData
): Promise<FullPersonRow[]> {
  const matched = sortByLastUpdatedDesc(await fetchFilteredRowsUncached(filters, companyData));
  const ids = matched.map((row) => row.id);
  const byId = await fetchPeopleByIds(ids);
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is FullPersonRow => row != null);
}

function toExportRow(row: FullPersonRow, companyData: CompanyJoinData): PersonExportRow {
  const company = row.company_id ? companyData.byId.get(row.company_id) : undefined;
  return {
    firstName: row.first_name,
    lastName: row.last_name,
    fullName: row.full_name,
    jobTitle: row.job_title,
    email: row.email,
    emailStatus: row.email_status,
    emailVerifiedAt: row.email_verified_at,
    phone: row.phone,
    phoneType: row.phone_type,
    phoneStatus: row.phone_status,
    phoneVerifiedAt: row.phone_verified_at,
    linkedinUrl: row.linkedin_url,
    linkedinUsername: row.linkedin_username,
    companyName: row.company_name,
    domain: row.domain,
    companyLinkedinUrl: company?.linkedin_url ?? null,
    city: row.city,
    state: row.state,
    country: row.country,
    sourceId: row.source_id,
    sources: normalizeSourceTokens(row.source),
    tags: row.tags ?? [],
    lastUpdated: row.last_updated,
    customData: toWebhookCustomData(row.custom_data),
  };
}

/** Full-record export: same filtered set as getAllFilteredPeople but with
 * every native column and all enrichment (custom_data) keys retained. */
export async function getAllFilteredPeopleForExport(
  filters: PersonListFilters
): Promise<PersonExportRow[]> {
  const companyData = await loadCompanyJoinData();
  const rows = await fetchFullFilteredPeople(filters, companyData);
  return rows.map((row) => toExportRow(row, companyData));
}

/** The full Clay webhook payload for one person: every native column (including
 * the joined company LinkedIn URL) plus each enrichment (custom_data) key
 * flattened to the top level. Enrichment is spread first so native columns stay
 * authoritative on any key collision. Keys are snake_case for clean Clay column
 * mapping; matches the CSV export's field set and custom_data filtering. */
function toClayPayload(row: FullPersonRow, companyData: CompanyJoinData): Record<string, unknown> {
  const company = row.company_id ? companyData.byId.get(row.company_id) : undefined;
  return {
    ...toWebhookCustomData(row.custom_data),
    person_id: row.id,
    first_name: row.first_name,
    last_name: row.last_name,
    full_name: row.full_name,
    job_title: row.job_title,
    email: row.email,
    email_status: row.email_status,
    email_verified_at: row.email_verified_at,
    phone: row.phone,
    phone_type: row.phone_type,
    phone_status: row.phone_status,
    phone_verified_at: row.phone_verified_at,
    linkedin_url: row.linkedin_url,
    linkedin_username: row.linkedin_username,
    source_id: row.source_id,
    company_id: row.company_id,
    company_name: row.company_name,
    company_domain: row.domain,
    company_linkedin_url: company?.linkedin_url ?? null,
    city: row.city,
    state: row.state,
    country: row.country,
    source: row.source,
    tags: row.tags,
    last_updated: row.last_updated,
  };
}

/** Clay push records for the current filtered view — the same set (and order)
 * as getAllFilteredPeople, each carrying the full flattened webhook payload. */
export async function getPeopleForClay(filters: PersonListFilters): Promise<ClayPushRecord[]> {
  const companyData = await loadCompanyJoinData();
  const rows = await fetchFullFilteredPeople(filters, companyData);
  return rows.map((row) => ({
    id: row.id,
    displayName: row.full_name,
    payload: toClayPayload(row, companyData),
  }));
}

/** Facet counts reflect the currently active filters, not the whole table —
 * e.g. narrowing to an Industry should make the Source dropdown show counts
 * within that narrowed set, not the global total (see the same pattern in
 * companies.ts::getCompanyFilterOptions). Each facet's own count excludes
 * its own filter so picking a value doesn't zero out its sibling options. */
export async function getPersonFilterOptions(
  filters: PersonListFilters = {}
): Promise<PersonFilterOptions> {
  const [companyData, rows] = await Promise.all([
    loadCompanyJoinData(),
    fetchBaseRows(toBaseFilters(filters)),
  ]);

  const niches = new Map<string, number>();
  const sources = new Map<string, number>();
  const countries = new Map<string, { label: string; count: number }>();
  const industries = new Map<string, { label: string; count: number }>();
  const emailStatuses = new Map<string, number>();
  const phoneTypes = new Map<string, number>();

  for (const row of rows) {
    const company = row.company_id ? companyData.byId.get(row.company_id) : undefined;

    const okCommon =
      matchesEmailPresence(row, filters) &&
      matchesPhonePresence(row, filters) &&
      matchesJobTitle(row, filters);
    if (!okCommon) continue;

    const okCountry = matchesCountry(row, filters);
    const okSource = matchesSource(row, filters);
    const okEmailStatus = matchesEmailStatus(row, filters);
    const okPhoneType = matchesPhoneType(row, filters);
    const okIndustry = matchesIndustry(company, filters);
    const okEmployee = matchesEmployeeSize(company, filters);
    const okNiche = matchesNiche(row, company, companyData.knownClients, filters);

    if (okCountry && okSource && okEmailStatus && okPhoneType && okIndustry && okEmployee) {
      for (const niche of personNiches(row, company, companyData.knownClients)) {
        niches.set(niche, (niches.get(niche) ?? 0) + 1);
      }
    }

    if (okNiche && okCountry && okEmailStatus && okPhoneType && okIndustry && okEmployee) {
      for (const token of normalizeSourceTokens(row.source)) {
        sources.set(token, (sources.get(token) ?? 0) + 1);
      }
    }

    if (okNiche && okSource && okEmailStatus && okPhoneType && okIndustry && okEmployee) {
      const country = normalizeCountry(row.country);
      if (country) {
        const existing = countries.get(country.id);
        countries.set(country.id, { label: country.label, count: (existing?.count ?? 0) + 1 });
      }
    }

    if (okNiche && okCountry && okSource && okEmailStatus && okPhoneType && okEmployee) {
      const industry = normalizeIndustry(company?.industry);
      if (industry) {
        const existing = industries.get(industry.id);
        industries.set(industry.id, { label: industry.label, count: (existing?.count ?? 0) + 1 });
      }
    }

    if (okNiche && okCountry && okSource && okIndustry && okEmployee && okPhoneType) {
      if (row.email_status) {
        emailStatuses.set(row.email_status, (emailStatuses.get(row.email_status) ?? 0) + 1);
      }
    }

    if (okNiche && okCountry && okSource && okIndustry && okEmployee && okEmailStatus) {
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
    countries: Array.from(countries.entries())
      .map(([id, { label, count }]) => ({ id, label, count }))
      .sort(sortDesc),
    industries: Array.from(industries.entries())
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

export interface CompanyPersonRow {
  id: string;
  fullName: string | null;
  jobTitle: string | null;
  email: string | null;
  phone: string | null;
}

/** Powers the "people linked to this company" drawer opened from the
 * companies table (see companies-table.tsx / people-drawer.tsx). Fetched
 * on demand per company rather than joined into the companies list query,
 * so the table payload stays cheap for every row while still rendering
 * enough per person (name, title, email, phone) to be useful in the drawer.
 * Capped at 500 — this is a browsing UI, not an export path. */
export async function getPeopleByCompanyId(companyId: string): Promise<CompanyPersonRow[]> {
  const { data, error } = await supabaseAdmin
    .from("people")
    .select("id,full_name,job_title,email,phone")
    .eq("company_id", companyId)
    .order("full_name", { ascending: true })
    .limit(500);

  if (error) throw error;

  return (data ?? []).map((row) => ({
    id: row.id,
    fullName: row.full_name,
    jobTitle: row.job_title,
    email: row.email,
    phone: row.phone,
  }));
}

export interface LinkedCompany {
  id: string;
  companyName: string | null;
  domain: string | null;
  qualityTier: string | null;
}

export interface PersonDetail {
  id: string;
  fullName: string | null;
  jobTitle: string | null;
  email: string | null;
  emailStatus: string | null;
  emailVerifiedAt: string | null;
  phone: string | null;
  phoneType: string | null;
  phoneStatus: string | null;
  phoneVerifiedAt: string | null;
  linkedinUrl: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  /** Person's own denormalized company name — populated even when linkedCompany is null */
  companyName: string | null;
  /** Person's own denormalized domain — populated even when linkedCompany is null */
  domain: string | null;
  sources: string[];
  tags: string[];
  lastUpdated: string | null;
  customData: Record<string, unknown>;
  linkedCompany: LinkedCompany | null;
}

// Additional to the shared blocklist in custom-data.ts — person-specific
// housekeeping fields per the People Detail spec.
const PERSON_EXTRA_BLOCKED_KEYS = [
  "company_linkedin_id",
  "connections_count",
  "apollo_id",
  "pushed_to_clay",
  "created_at",
  "updated_at",
];

export async function getPersonDetail(id: string): Promise<PersonDetail | null> {
  const { data, error } = await supabaseAdmin.from("people").select("*").eq("id", id).maybeSingle();

  if (error) throw error;
  if (!data) return null;

  let linkedCompany: LinkedCompany | null = null;
  if (data.company_id) {
    const { data: company, error: companyError } = await supabaseAdmin
      .from("companies")
      .select("id,company_name,domain,quality_tier")
      .eq("id", data.company_id)
      .maybeSingle();
    if (companyError) throw companyError;
    if (company) {
      linkedCompany = {
        id: company.id,
        companyName: company.company_name,
        domain: company.domain,
        qualityTier: company.quality_tier,
      };
    }
  }

  return {
    id: data.id,
    fullName: data.full_name,
    jobTitle: data.job_title,
    email: data.email,
    emailStatus: data.email_status,
    emailVerifiedAt: data.email_verified_at,
    phone: data.phone,
    phoneType: data.phone_type,
    phoneStatus: data.phone_status,
    phoneVerifiedAt: data.phone_verified_at,
    linkedinUrl: data.linkedin_url,
    city: data.city,
    state: data.state,
    country: data.country,
    companyName: data.company_name,
    domain: data.domain,
    sources: normalizeSourceTokens(data.source),
    tags: data.tags ?? [],
    lastUpdated: data.last_updated,
    customData: filterCustomData(data.custom_data, PERSON_EXTRA_BLOCKED_KEYS),
    linkedCompany,
  };
}

export { employeeBucketOf };
