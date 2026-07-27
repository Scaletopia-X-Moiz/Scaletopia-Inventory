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
import type { VirtualColumnFilter } from "@/lib/data/virtual-columns";

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
  /** Virtual-column predicates over custom_data enrichment fields (ticket #33,
   * docs/adr/0002-virtual-column-enrichment-filtering.md). Evaluated by the
   * shared SQL predicate (lib/data/virtual-columns.sql), not the PostgREST
   * builder below — see resolveVirtualFilterIds. */
  virtualFilters?: VirtualColumnFilter[];
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
  company_linkedin_url: string | null;
}

const LIST_COLUMNS =
  "id,company_id,full_name,job_title,email,phone,linkedin_url,domain,city,state,country,source,tags,last_updated,email_status,email_verified_at,phone_type,phone_status,phone_verified_at,company_name,company_linkedin_url";

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
 * industry_id, country_id, email_status, phone_type. `.in`/`.notIn` both
 * append a separate querystring filter on the same column, and PostgREST ANDs
 * same-column filters together — exactly the "exclude wins, include must also
 * match" semantics lib/data/include-exclude.ts's matchesIncludeExclude
 * implements in-app. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyScalarIncludeExclude(query: any, column: string, filter: IncludeExclude | undefined): any {
  if (!filter) return query;
  let q = query;
  if (filter.exclude.length) q = q.notIn(column, filter.exclude);
  if (filter.include.length) q = q.in(column, filter.include);
  return q;
}

/** Applies an include/exclude filter to a multi-valued array column (
 * source_tokens, niche_tokens). Include matches any overlap (`&&`); exclude
 * rejects any overlap. Both hold our own canonical slugs with no
 * delimiter/reserved characters, so the manual `{a,b}` literal is safe
 * without PostgREST's quoting. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyArrayIncludeExclude(query: any, column: string, filter: IncludeExclude | undefined): any {
  if (!filter) return query;
  let q = query;
  if (filter.exclude.length) q = q.not(column, "ov", `{${filter.exclude.join(",")}}`);
  if (filter.include.length) q = q.overlaps(column, filter.include);
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

/** jobTitle matches any of several comma-separated terms, case-insensitively —
 * pushed to Postgres as an OR of ILIKE clauses. Not one of the six facet
 * dimensions (companies has no equivalent and it's cheap as-is), so it's just
 * folded into the base WHERE like search/employee size. */
function jobTitleOrClause(raw: string | undefined): string {
  const terms = (raw ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
  return terms.map((t) => `job_title.ilike.%${t.replace(/[%,]/g, "")}%`).join(",");
}

/** Pushes every /people filter into Postgres: search (ILIKE), jobTitle (OR of
 * ILIKE), employee size (range or bucket OR-clause, now a native column
 * instead of a join through companies), and the canonical-column filters
 * (niche, source, industry, country) plus email/phone presence and status —
 * all cleanly pushable now that country_id/source_tokens/industry_id/
 * employee_count/niche_tokens/company_linkedin_url are populated on people
 * directly (see docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md
 * and the people-side tickets #20-#25 that extend it). Mirrors
 * applyCompanyFilters in lib/data/companies.ts. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function applyPersonFilters(query: any, filters: PersonListFilters): any {
  let q = query;

  const search = filters.search?.trim();
  if (search) {
    const term = search.replace(/[%,]/g, "");
    q = q.or(`full_name.ilike.%${term}%,email.ilike.%${term}%`);
  }

  const jobTitleClause = jobTitleOrClause(filters.jobTitle);
  if (jobTitleClause) q = q.or(jobTitleClause);

  if (filters.employeeMin != null || filters.employeeMax != null) {
    if (filters.employeeMin != null) q = q.gte("employee_count", filters.employeeMin);
    if (filters.employeeMax != null) q = q.lte("employee_count", filters.employeeMax);
  } else if (filters.employeeBucket?.length) {
    const clause = employeeBucketOrClause(filters.employeeBucket);
    if (clause) q = q.or(clause);
  }

  q = applyArrayIncludeExclude(q, "niche_tokens", filters.niche);
  q = applyArrayIncludeExclude(q, "source_tokens", filters.source);
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

/** Resolves the id set filters.virtualFilters narrows to via the shared SQL
 * predicate (lib/data/virtual-columns.sql), or `null` when no virtual filter
 * is active — the no-op case every list/export/push call site below must
 * preserve exactly, since this ticket introduces the seam with no operator UI
 * and existing behavior must stay unchanged. Kept separate from
 * applyPersonFilters because PostgREST's query builder can't express the
 * predicate's cast-safe numeric/date comparisons (see ADR-0002) — the
 * predicate has to be evaluated in SQL, not built through the builder. Sends
 * the *full* filter payload (not just virtualFilters) so
 * people_matching_virtual_filters can apply the same native predicate
 * applyPersonFilters would, bounding its scan to the actual working set
 * instead of the whole table. Mirrors resolveVirtualFilterIds in
 * lib/data/companies.ts. */
async function resolveVirtualFilterIds(filters: PersonListFilters): Promise<string[] | null> {
  if (!filters.virtualFilters?.length) return null;
  const { data, error } = await supabaseAdmin.rpc("people_matching_virtual_filters", {
    filters: toFilterOptionsRpcPayload(filters),
  });
  if (error) throw error;
  return (data as VirtualFilterIdRow[]).map((row) => row.id);
}

async function fetchFilteredRows(filters: PersonListFilters): Promise<RawPersonRow[]> {
  const virtualIds = await resolveVirtualFilterIds(filters);
  return fetchAllRows<RawPersonRow>("people", LIST_COLUMNS, (query) => {
    const q = applyPersonFilters(query, filters);
    return virtualIds !== null ? q.in("id", virtualIds) : q;
  });
}

/** No-op — kept so callers (reverify, reverify-phone) don't need touching.
 * There is no app-level cache to invalidate now that filtering, faceting, and
 * sorting all run in Postgres on every request (mirrors
 * invalidateCompaniesListCache in lib/data/companies.ts). */
export function invalidatePeopleListCache(): void {}

function toListRow(row: RawPersonRow): PersonListRow {
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
    companyLinkedinUrl: row.company_linkedin_url,
    city: row.city,
    state: row.state,
    country: row.country,
    sources: normalizeSourceTokens(row.source),
    lastUpdated: row.last_updated,
  };
}

/** The rendered /people list page: filter, sort, and paginate entirely in
 * Postgres (see docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md,
 * extended to people by tickets #20-#25). Deep pages degrade gradually as
 * OFFSET discards preceding rows — same accepted trade-off as /companies. */
export async function getPeople(
  filters: PersonListFilters,
  page = 1,
  pageSize = 50
): Promise<PersonListResult> {
  let query = supabaseAdmin.from("people").select(LIST_COLUMNS, { count: "exact" });
  query = applyPersonFilters(query, filters);
  const virtualIds = await resolveVirtualFilterIds(filters);
  if (virtualIds !== null) query = query.in("id", virtualIds);
  query = query
    .order("last_updated", { ascending: false, nullsFirst: false })
    .order("id", { ascending: true });

  const start = (page - 1) * pageSize;
  const { data, error, count } = await query.range(start, start + pageSize - 1);
  if (error) throw error;

  const rows = (data ?? []) as unknown as RawPersonRow[];

  return {
    rows: rows.map(toListRow),
    total: count ?? 0,
    page,
    pageSize,
  };
}

/** Same query + filtering as getPeople, with no pagination — the export
 * function must run through the identical filtered query, not a separate path. */
export async function getAllFilteredPeople(filters: PersonListFilters): Promise<PersonListRow[]> {
  return sortByLastUpdatedDesc(await fetchFilteredRows(filters)).map(toListRow);
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
 * cheaply through the filtered Postgres query, then pulls every column
 * (including custom_data) only for those ids — so it never fetches `*` for the
 * whole people table, which was slow enough to stall a push before the first
 * row went out. Returned already sorted, in the same order as the list/export. */
async function fetchFullFilteredPeople(filters: PersonListFilters): Promise<FullPersonRow[]> {
  const matched = sortByLastUpdatedDesc(await fetchFilteredRows(filters));
  const ids = matched.map((row) => row.id);
  const byId = await fetchPeopleByIds(ids);
  return ids
    .map((id) => byId.get(id))
    .filter((row): row is FullPersonRow => row != null);
}

function toExportRow(row: FullPersonRow): PersonExportRow {
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
    companyLinkedinUrl: row.company_linkedin_url,
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
  const rows = await fetchFullFilteredPeople(filters);
  return rows.map(toExportRow);
}

/** The full Clay webhook payload for one person: every native column (including
 * the person's own denormalized company LinkedIn URL) plus each enrichment
 * (custom_data) key flattened to the top level. Enrichment is spread first so
 * native columns stay authoritative on any key collision. Keys are snake_case
 * for clean Clay column mapping; matches the CSV export's field set and
 * custom_data filtering. */
function toClayPayload(row: FullPersonRow): Record<string, unknown> {
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
    company_linkedin_url: row.company_linkedin_url,
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
  const rows = await fetchFullFilteredPeople(filters);
  return rows.map((row) => ({
    id: row.id,
    displayName: row.full_name,
    payload: toClayPayload(row),
  }));
}

interface FacetIdCount {
  id: string;
  count: number;
}

interface PersonFilterOptionsRpcResult {
  niches: FacetIdCount[];
  sources: FacetIdCount[];
  industries: FacetIdCount[];
  countries: FacetIdCount[];
  emailStatuses: FacetIdCount[];
  phoneTypes: FacetIdCount[];
}

/** Serializes PersonListFilters into the jsonb shape person_filter_options
 * (lib/data/people-canonical-columns.sql) expects. Employee buckets are
 * resolved to {min_v,max_v} ranges here (from the same EMPLOYEE_BUCKETS
 * TypeScript source of truth applyPersonFilters/employeeBucketOrClause use)
 * rather than passing bucket ids for the RPC to interpret, so the bucket
 * boundaries never need to be duplicated in SQL. Mirrors
 * toFilterOptionsRpcPayload in lib/data/companies.ts, plus jobTitle — the
 * one filter dimension people has that companies doesn't. */
export function toFilterOptionsRpcPayload(filters: PersonListFilters): Record<string, unknown> {
  const hasExplicitRange = filters.employeeMin != null || filters.employeeMax != null;
  return {
    search: filters.search ?? null,
    jobTitle: filters.jobTitle ?? null,
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
    virtualFilters: filters.virtualFilters ?? [],
  };
}

function sortByCountDesc(a: { count: number }, b: { count: number }): number {
  return b.count - a.count;
}

/** Facet counts reflect the currently active filters, not the whole table —
 * e.g. narrowing to an Industry should make the Source dropdown show counts
 * within that narrowed set, not the global total. Each facet's own count
 * excludes its own filter (so picking a value doesn't zero out its sibling
 * options), but is scoped by every other active filter. All six dimensions
 * are computed by a single Postgres RPC (lib/data/people-canonical-columns.sql);
 * labels are attached here from the TypeScript alias tables
 * (sourceLabel/industryLabel/countryLabel) so they stay single-edit-point.
 * Mirrors getCompanyFilterOptions in lib/data/companies.ts. */
export async function getPersonFilterOptions(
  filters: PersonListFilters = {}
): Promise<PersonFilterOptions> {
  const { data, error } = await supabaseAdmin.rpc("person_filter_options", {
    filters: toFilterOptionsRpcPayload(filters),
  });
  if (error) throw error;
  const result = data as PersonFilterOptionsRpcResult;

  return {
    niches: result.niches
      .map(({ id, count }) => ({ id, label: id, count }))
      .sort(sortByCountDesc),
    sources: result.sources
      .map(({ id, count }) => ({ id, label: sourceLabel(id), count }))
      .sort(sortByCountDesc),
    countries: result.countries
      .map(({ id, count }) => ({ id, label: countryLabel(id), count }))
      .sort(sortByCountDesc),
    industries: result.industries
      .map(({ id, count }) => ({ id, label: industryLabel(id), count }))
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

function firstOf<T>(value: T | T[] | null): T | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

interface RawPersonDetailCompany {
  id: string;
  company_name: string | null;
  domain: string | null;
  quality_tier: string | null;
}

export async function getPersonDetail(id: string): Promise<PersonDetail | null> {
  const { data, error } = await supabaseAdmin
    .from("people")
    .select("*, companies(id,company_name,domain,quality_tier)")
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;

  const company = firstOf(
    data.companies as RawPersonDetailCompany | RawPersonDetailCompany[] | null
  );
  const linkedCompany: LinkedCompany | null = company
    ? {
        id: company.id,
        companyName: company.company_name,
        domain: company.domain,
        qualityTier: company.quality_tier,
      }
    : null;

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
