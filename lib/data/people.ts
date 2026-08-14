import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/data/fetch-all-rows";
import { normalizeSourceTokens, sourceLabel } from "@/lib/data/source";
import { countryLabel } from "@/lib/data/country";
import { industryLabel } from "@/lib/data/industry";
import { EMPLOYEE_BUCKETS, employeeBucketOf } from "@/lib/data/employee-size";
import { filterCustomData, toWebhookCustomData } from "@/lib/data/custom-data";
import { sortByLastUpdatedDesc } from "@/lib/data/sort";
import type { ClayPushRecord } from "@/lib/clay/types";
import type { GhlPushRecord } from "@/lib/ghl/types";
import type { EmailBisonPushRecord } from "@/lib/emailbison/types";
import type { PushRecordCompanyNameFields } from "@/lib/push/resolve-default-field-mapping";
import {
  getAllFilteredCompanies,
  filteredCompaniesHaveLinkedPersonWithBrandName,
  type CompanyListFilters,
} from "@/lib/data/companies";
import { getPushJobPersonIds, type PushJobOutcome } from "@/lib/data/push-jobs";
import type { IncludeExclude } from "@/lib/data/include-exclude";
import type { ActiveVirtualColumn, VirtualFilterSet } from "@/lib/data/virtual-columns";
import { isFilterSetActive } from "@/lib/data/virtual-columns";
import {
  pushStatusRpcPayload,
  type PushPlatform,
  type PushStatusCounts,
  type PushStatusFilter,
} from "@/lib/data/push-status-filter";

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
  /** Restrict to exactly the people a push run touched, via the per-record
   * tags in `push_job_records` (#123) — `id IN (SELECT person_id FROM
   * push_job_records WHERE push_job_id = pushJobId)`. Stable across later
   * pushes to the same client, unlike a trigger-time filter replay. Resolved to
   * an id set (resolvePushJobIds) rather than pushed through the PostgREST
   * builder, since PostgREST can't express the subselect. */
  pushJobId?: string;
  /** Optional outcome sub-scope for pushJobId — only succeeded / only failed
   * records. Undefined (default) keeps all touched records so failures stay
   * visible for troubleshooting. */
  pushJobOutcome?: PushJobOutcome;
  /** Push-status filter (client × platform × pushed/not_pushed). Shared shape
   * with CompanyListFilters via lib/data/push-status-filter.ts. Only the type
   * and RPC payload key land here (#126) — predicate evaluation is F2/P1. */
  pushStatus?: PushStatusFilter;
  /** Virtual-column predicates over custom_data enrichment fields (ticket #33,
   * docs/adr/0002-virtual-column-enrichment-filtering.md). Evaluated by the
   * shared SQL predicate (lib/data/virtual-columns.sql), not the PostgREST
   * builder below — see resolveVirtualFilterIds. Two-level grouped AND/OR logic
   * since ticket #117 (a single AND group reproduces the pre-#117 flat
   * behavior). */
  virtualFilters?: VirtualFilterSet;
  /** Enrichment fields added as display-only virtual columns on the rendered
   * page (independent of virtualFilters — a column can be shown before it has
   * a filter). Only getPeople (the rendered page) reads this; it has no
   * bearing on which rows match, so it's not part of toFilterOptionsRpcPayload.
   * Mirrors CompanyListFilters.virtualColumns in lib/data/companies.ts. */
  virtualColumns?: ActiveVirtualColumn[];
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
  /** custom_data[key] per active virtual column (filters.virtualColumns) —
   * only populated for getPeople, mirroring CompanyListRow.virtualColumnValues
   * in lib/data/companies.ts. */
  virtualColumnValues?: Record<string, unknown>;
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

/** Split an id list into fixed-size chunks. Mirrors chunkIds in
 * lib/data/companies.ts — keeps every by-id `.in()` clause below under
 * PostgREST's URL length limits. */
function chunkIds(ids: string[], size: number): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) {
    chunks.push(ids.slice(i, i + size));
  }
  return chunks;
}

/** PostgREST caps a single response — including an RPC's result set — at 1000
 * rows, so a virtual filter matching more than 1000 people would otherwise
 * come back silently truncated to the first 1000. Paged the same way
 * fetchAllRows pages a table query. Mirrors RPC_PAGE_SIZE in
 * lib/data/companies.ts. */
const RPC_PAGE_SIZE = 1000;

/** Resolves the id set filters.virtualFilters (or filters.pushStatus) narrows
 * to via the shared SQL predicate (lib/data/virtual-columns.sql), or `null`
 * when neither a virtual filter nor a push filter is active — the no-op case
 * every list/export/push call site below must preserve exactly, so existing
 * behavior with no filter active stays byte-identical. The push predicate rides
 * the same seam: people_matching_virtual_filters (F2) applies it in SQL from
 * the payload's `pushStatus` key, and a virtual filter AND a push filter active
 * together intersect in that one scan. Kept separate from
 * applyPersonFilters because PostgREST's query builder can't express the
 * predicate's cast-safe numeric/date comparisons (see ADR-0002) — the
 * predicate has to be evaluated in SQL, not built through the builder. Sends
 * the *full* filter payload (not just virtualFilters) so
 * people_matching_virtual_filters can apply the same native predicate
 * applyPersonFilters would, bounding its scan to the actual working set
 * instead of the whole table. Mirrors resolveVirtualFilterIds in
 * lib/data/companies.ts. */
async function resolveVirtualFilterIds(filters: PersonListFilters): Promise<string[] | null> {
  if (!isFilterSetActive(filters.virtualFilters) && !filters.pushStatus) return null;
  const payload = toFilterOptionsRpcPayload(filters);

  const first = await supabaseAdmin
    .rpc("people_matching_virtual_filters", { filters: payload }, { count: "exact" })
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
          .rpc("people_matching_virtual_filters", { filters: payload })
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

/** Ids per `.in()` chunk when re-fetching rows for a resolved virtual-filter id
 * set below. Mirrors VIRTUAL_FILTER_ROW_CHUNK_SIZE in lib/data/companies.ts. */
const VIRTUAL_FILTER_ROW_CHUNK_SIZE = 200;

/** LIST_COLUMNS rows for a virtual-filter id set (resolveVirtualFilterIds),
 * fanned out and merged — a single `.in("id", ids)` throws PostgREST's "Bad
 * Request" once the id list runs past a few hundred entries (confirmed
 * empirically against the live table). Mirrors fetchRowsForVirtualIds in
 * lib/data/companies.ts. */
async function fetchRowsForVirtualIds(ids: string[]): Promise<RawPersonRow[]> {
  if (ids.length === 0) return [];
  const chunks = chunkIds(ids, VIRTUAL_FILTER_ROW_CHUNK_SIZE);
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      fetchAllRows<RawPersonRow>("people", LIST_COLUMNS, (query) => query.in("id", chunk))
    )
  );
  return chunkResults.flat();
}

/** The person-id set filters.pushJobId restricts to (its `push_job_records`
 * tags, optionally outcome-scoped), or null when no pushJobId is set — the
 * no-op every call site preserves, exactly like resolveVirtualFilterIds. */
async function resolvePushJobIds(filters: PersonListFilters): Promise<string[] | null> {
  if (!filters.pushJobId) return null;
  return getPushJobPersonIds(filters.pushJobId, filters.pushJobOutcome);
}

/** LIST_COLUMNS rows for an id set with the *standard* filters (search, niche,
 * status, …) reapplied per chunk — used for the pushJobId path, where the id
 * set comes straight from `push_job_records` and hasn't had those filters
 * applied yet (unlike the virtual-filter RPC, which bakes them in). Chunked for
 * the same URL-length reason as fetchRowsForVirtualIds. */
async function fetchRowsForRestrictedIds(
  ids: string[],
  filters: PersonListFilters
): Promise<RawPersonRow[]> {
  if (ids.length === 0) return [];
  const chunks = chunkIds(ids, VIRTUAL_FILTER_ROW_CHUNK_SIZE);
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      fetchAllRows<RawPersonRow>("people", LIST_COLUMNS, (query) =>
        applyPersonFilters(query.in("id", chunk), filters)
      )
    )
  );
  return chunkResults.flat();
}

/** The fully filtered LIST rows (unsorted) when any id-restricting dimension is
 * active — virtualFilters, pushJobId, or both — or null to signal "use the
 * plain PostgREST path". Unifies the two id-set dimensions so getPeople and the
 * export/push fetches share one branch:
 *  - virtual only: the RPC already applied the standard filters, so fetch by id.
 *  - pushJobId (± other standard filters): reapply standard filters per chunk.
 *  - both: intersect the sets; the virtual RPC already carries standard
 *    filters, so the intersection needs only an id lookup. */
async function resolveRestrictedRows(filters: PersonListFilters): Promise<RawPersonRow[] | null> {
  const [virtualIds, pushIds] = await Promise.all([
    resolveVirtualFilterIds(filters),
    resolvePushJobIds(filters),
  ]);
  if (virtualIds === null && pushIds === null) return null;
  if (pushIds === null) return fetchRowsForVirtualIds(virtualIds as string[]);
  if (virtualIds === null) return fetchRowsForRestrictedIds(pushIds, filters);
  const virtualSet = new Set(virtualIds);
  return fetchRowsForVirtualIds(pushIds.filter((id) => virtualSet.has(id)));
}

async function fetchFilteredRows(filters: PersonListFilters): Promise<RawPersonRow[]> {
  const restricted = await resolveRestrictedRows(filters);
  if (restricted !== null) return restricted;
  return fetchAllRows<RawPersonRow>("people", LIST_COLUMNS, (query) =>
    applyPersonFilters(query, filters)
  );
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

/** Ids per `.in()` chunk when querying enrichment values by id below. */
const ENRICHMENT_VALUES_ID_CHUNK_SIZE = 100;

/** custom_data[key] for each active virtual column, scoped to just the ids on
 * the rendered page — mirrors getCompanyEnrichmentValues in
 * lib/data/companies.ts: avoids pulling the whole custom_data blob (and the
 * whole table) just to populate a handful of display columns for one page. */
async function getPersonEnrichmentValues(
  ids: string[],
  keys: string[]
): Promise<Map<string, Record<string, unknown>>> {
  const result = new Map<string, Record<string, unknown>>();
  if (ids.length === 0 || keys.length === 0) return result;

  const chunks = chunkIds(ids, ENRICHMENT_VALUES_ID_CHUNK_SIZE);
  const chunkResults = await Promise.all(
    chunks.map((chunk) =>
      fetchAllRows<{ id: string; custom_data: Record<string, unknown> | null }>(
        "people",
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

/** The rendered /people list page: filter, sort, and paginate entirely in
 * Postgres (see docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md,
 * extended to people by tickets #20-#25). Deep pages degrade gradually as
 * OFFSET discards preceding rows — same accepted trade-off as /companies. */
export async function getPeople(
  filters: PersonListFilters,
  page = 1,
  pageSize = 50
): Promise<PersonListResult> {
  const restricted = await resolveRestrictedRows(filters);
  const start = (page - 1) * pageSize;

  let pageRows: PersonListRow[];
  let total: number;

  if (restricted !== null) {
    // An id-restricting dimension is active (virtualFilters and/or pushJobId):
    // the matched id set can't be pushed into a single `.in()`/`.range()`
    // Postgres query past a few hundred ids (see fetchRowsForVirtualIds), so
    // order/paginate in app code over the already-resolved full match instead —
    // mirrors getCompanies in lib/data/companies.ts.
    const matched = sortByLastUpdatedDesc(restricted);
    total = matched.length;
    pageRows = matched.slice(start, start + pageSize).map(toListRow);
  } else {
    let query = supabaseAdmin.from("people").select(LIST_COLUMNS, { count: "exact" });
    query = applyPersonFilters(query, filters);
    query = query
      .order("last_updated", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true });

    const { data, error, count } = await query.range(start, start + pageSize - 1);
    if (error) throw error;

    const rows = (data ?? []) as unknown as RawPersonRow[];
    pageRows = rows.map(toListRow);
    total = count ?? 0;
  }

  if (filters.virtualColumns?.length) {
    const keys = filters.virtualColumns.map((c) => c.key);
    const values = await getPersonEnrichmentValues(pageRows.map((r) => r.id), keys);
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
  employee_count: number | null;
  niche_tokens: string[] | null;
  /** Not in LIST_COLUMNS (the narrow list-page select) — only reachable via
   * FULL_ROW_COLUMNS's `*`, needed for the createdAt bindable push field. */
  created_at: string | null;
  /** The linked company's cleaned name (lib/clean-names/clean-names.ts),
   * joined in alongside the person's own denormalized (raw) company_name so
   * push builders can prefer it. null when the company has no linked row or
   * hasn't been cleaned yet. */
  companies: {
    brand_name: string | null;
    city: string | null;
    state: string | null;
    country: string | null;
    industry: string | null;
    employee_count: number | null;
    website_url: string | null;
    linkedin_url: string | null;
    domain: string | null;
    phone: string | null;
    phone_type: string | null;
    email: string | null;
    email_status: string | null;
    niche: string | null;
    quality_tier: string | null;
    // Ground-truth audit against the live `companies` table (39 columns)
    // found these 16 with no bindable field yet — phone_status fills a
    // genuine gap (phone_type was covered, phone_status wasn't); the rest had
    // no bindable field at all. id/country_id/industry_id/custom_data/
    // pushed_to_clay/pushed_to_clay_at/source_tokens deliberately excluded
    // (see EmailBisonPushRecord's doc comment).
    phone_status: string | null;
    client: string | null;
    created_at: string | null;
    description: string | null;
    domain_status: string | null;
    email_verified_at: string | null;
    founded_year: number | null;
    keywords: string[] | null;
    last_updated: string | null;
    mx_provider: string | null;
    phone_verified_at: string | null;
    /** Text column in the live schema (e.g. "0-99999", "USD $6,000.00"), not
     * numeric — confirmed via a live-data probe. */
    revenue: string | null;
    security_gateway: string | null;
    source: string | null;
    tags: string[] | null;
    technologies: string[] | null;
  } | null;
}

/** Select string for the full `*` row fetches below — joins in the linked
 * company's brand_name (ticket: GHL/EmailBison push should prefer the
 * cleaned company name over the raw denormalized one) plus every real company
 * column the push dialogs expose as a bindable `company*` field, so a
 * Companies-side push can bind any real company column without a second round
 * trip. These columns already exist on the companies table — no DDL needed. */
const FULL_ROW_COLUMNS =
  "*, companies(brand_name, city, state, country, industry, employee_count, website_url, linkedin_url, domain, phone, phone_type, phone_status, email, email_status, niche, quality_tier, client, created_at, description, domain_status, email_verified_at, founded_year, keywords, last_updated, mx_provider, phone_verified_at, revenue, security_gateway, source, tags, technologies)";

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
      window.map((chunk) => supabaseAdmin.from("people").select(FULL_ROW_COLUMNS).in("id", chunk))
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

/** One candidate resolved for the GHL push (ticket #47): the GHL contact
 * fields (GhlPushRecord) plus the identity/phone-type columns the push engine
 * needs but the payload itself doesn't carry. `niche` prefers the linked
 * company's niche and falls back to the first tag-parsed token, mirroring how
 * niche_tokens itself is populated (see lib/import/push.ts). */
export interface GhlPushCandidate {
  id: string;
  displayName: string | null;
  phoneType: string | null;
  record: GhlPushRecord;
  /** Raw custom_data blob, carried alongside `record` so the push engine can
   * resolve a field-mapping step's virtual-column → GHL-field pairs (ticket
   * #51) without a second fetch. */
  customData: Record<string, unknown> | null;
}

function toGhlPushRecord(row: FullPersonRow): GhlPushRecord {
  return {
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    companyName: row.company_name,
    brandName: row.companies?.brand_name ?? null,
    city: row.city,
    country: row.country,
    niche: row.niche_tokens?.[0] ?? null,
    employeeCount: row.employee_count,
    source: row.source,
    // Remaining person-own real columns (ground-truth audit, 2026-08-15).
    title: row.job_title,
    website: row.domain,
    state: row.state,
    fullName: row.full_name,
    linkedinUrl: row.linkedin_url,
    linkedinUsername: row.linkedin_username,
    phoneType: row.phone_type,
    phoneStatus: row.phone_status,
    emailStatus: row.email_status,
    sourceId: row.source_id,
    tags: row.tags,
    emailVerifiedAt: row.email_verified_at,
    phoneVerifiedAt: row.phone_verified_at,
    lastUpdated: row.last_updated,
    createdAt: row.created_at,
    // Linked company's real columns (company* namespace).
    companyCity: row.companies?.city ?? null,
    companyState: row.companies?.state ?? null,
    companyCountry: row.companies?.country ?? null,
    companyIndustry: row.companies?.industry ?? null,
    companyWebsiteUrl: row.companies?.website_url ?? null,
    companyLinkedinUrl: row.companies?.linkedin_url ?? null,
    companyDomain: row.companies?.domain ?? null,
    companyPhone: row.companies?.phone ?? null,
    companyPhoneType: row.companies?.phone_type ?? null,
    companyPhoneStatus: row.companies?.phone_status ?? null,
    companyEmail: row.companies?.email ?? null,
    companyEmailStatus: row.companies?.email_status ?? null,
    companyEmailVerifiedAt: row.companies?.email_verified_at ?? null,
    companyPhoneVerifiedAt: row.companies?.phone_verified_at ?? null,
    companyQualityTier: row.companies?.quality_tier ?? null,
    companyClient: row.companies?.client ?? null,
    companyDescription: row.companies?.description ?? null,
    companyFoundedYear: row.companies?.founded_year ?? null,
    companyRevenue: row.companies?.revenue ?? null,
    companyDomainStatus: row.companies?.domain_status ?? null,
    companyMxProvider: row.companies?.mx_provider ?? null,
    companySecurityGateway: row.companies?.security_gateway ?? null,
    companyKeywords: row.companies?.keywords ?? null,
    companyTechnologies: row.companies?.technologies ?? null,
    companyTags: row.companies?.tags ?? null,
    companyCreatedAt: row.companies?.created_at ?? null,
    companyLastUpdated: row.companies?.last_updated ?? null,
  };
}

/** GHL push candidates for the current filtered view — the same set (and
 * order) as getAllFilteredPeople. Includes every matched person regardless of
 * phone_type; the push engine (lib/ghl/push-to-ghl.ts) is responsible for
 * splitting eligible (mobile/toll-free) from skipped (landline/other). */
export async function getPeopleForGhl(filters: PersonListFilters): Promise<GhlPushCandidate[]> {
  const rows = await fetchFullFilteredPeople(filters);
  return rows.map((row) => ({
    id: row.id,
    displayName: row.full_name,
    phoneType: row.phone_type,
    record: toGhlPushRecord(row),
    customData: row.custom_data,
  }));
}

/** One candidate resolved for either EmailBison push action (ticket #55): the
 * EmailBison lead fields (EmailBisonPushRecord) the payload builder
 * (lib/emailbison/lead-payload.ts) needs, plus the raw custom_data blob so the
 * push engine can resolve a custom-variable entry bound to a virtual column
 * (issue #52) without a second fetch. Both getPeopleForEmailBison and
 * getPeopleForEmailBisonByCompanyFilters below produce this same shape, so
 * the People-table and Companies-table entity wrappers built in later
 * tickets converge on one candidate type. Mirrors GhlPushCandidate. */
export interface EmailBisonPushCandidate {
  id: string;
  displayName: string | null;
  record: EmailBisonPushRecord;
  customData: Record<string, unknown> | null;
}

/** People has no dedicated "website" column — domain (the linked company's
 * bare domain, denormalized onto people at import time) is the closest
 * available field and mirrors how toGhlPushRecord uses companyName without a
 * separate website field. */
function toEmailBisonPushRecord(row: FullPersonRow): EmailBisonPushRecord {
  return {
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    companyName: row.company_name,
    brandName: row.companies?.brand_name ?? null,
    title: row.job_title,
    website: row.domain,
    // Person's own real columns.
    city: row.city,
    state: row.state,
    country: row.country,
    fullName: row.full_name,
    linkedinUrl: row.linkedin_url,
    linkedinUsername: row.linkedin_username,
    phoneType: row.phone_type,
    phoneStatus: row.phone_status,
    emailStatus: row.email_status,
    sourceId: row.source_id,
    // Remaining person-own real columns (ground-truth audit, 2026-08-15).
    tags: row.tags,
    emailVerifiedAt: row.email_verified_at,
    phoneVerifiedAt: row.phone_verified_at,
    lastUpdated: row.last_updated,
    createdAt: row.created_at,
    // Linked company's real columns (company* namespace).
    companyCity: row.companies?.city ?? null,
    companyState: row.companies?.state ?? null,
    companyCountry: row.companies?.country ?? null,
    companyIndustry: row.companies?.industry ?? null,
    companyEmployeeCount: row.companies?.employee_count ?? null,
    companyWebsiteUrl: row.companies?.website_url ?? null,
    companyLinkedinUrl: row.companies?.linkedin_url ?? null,
    companyDomain: row.companies?.domain ?? null,
    companyPhone: row.companies?.phone ?? null,
    companyPhoneType: row.companies?.phone_type ?? null,
    companyEmail: row.companies?.email ?? null,
    companyEmailStatus: row.companies?.email_status ?? null,
    companyNiche: row.companies?.niche ?? null,
    companyQualityTier: row.companies?.quality_tier ?? null,
    companyPhoneStatus: row.companies?.phone_status ?? null,
    companyClient: row.companies?.client ?? null,
    companyCreatedAt: row.companies?.created_at ?? null,
    companyDescription: row.companies?.description ?? null,
    companyDomainStatus: row.companies?.domain_status ?? null,
    companyEmailVerifiedAt: row.companies?.email_verified_at ?? null,
    companyFoundedYear: row.companies?.founded_year ?? null,
    companyKeywords: row.companies?.keywords ?? null,
    companyLastUpdated: row.companies?.last_updated ?? null,
    companyMxProvider: row.companies?.mx_provider ?? null,
    companyPhoneVerifiedAt: row.companies?.phone_verified_at ?? null,
    companyRevenue: row.companies?.revenue ?? null,
    companySecurityGateway: row.companies?.security_gateway ?? null,
    companySource: row.companies?.source ?? null,
    companyTags: row.companies?.tags ?? null,
    companyTechnologies: row.companies?.technologies ?? null,
  };
}

function toEmailBisonPushCandidate(row: FullPersonRow): EmailBisonPushCandidate {
  return {
    id: row.id,
    displayName: row.full_name,
    record: toEmailBisonPushRecord(row),
    customData: row.custom_data,
  };
}

/** EmailBison push candidates for the current People-table filtered view —
 * the same set (and order) as getAllFilteredPeople. Entry point for both
 * "Add to EmailBison" and "Add to Campaign" when triggered from the People
 * table. */
export async function getPeopleForEmailBison(
  filters: PersonListFilters
): Promise<EmailBisonPushCandidate[]> {
  const rows = await fetchFullFilteredPeople(filters);
  return rows.map(toEmailBisonPushCandidate);
}

/** Ids per `.in("company_id", ...)` chunk when re-fetching people for a
 * resolved Companies-table id set below — same URL-length rationale as
 * VIRTUAL_FILTER_ROW_CHUNK_SIZE/FULL_ROW_ID_CHUNK_SIZE above. */
const COMPANY_ID_CHUNK_SIZE = 200;

/** Full `*` people rows for a set of company ids, fanned out across chunks
 * with the same bounded concurrency as fetchPeopleByIds — a company filter
 * can resolve to as many chunks as an unfiltered full-row fetch, so this
 * needs the same cap or it reproduces the stalled-push problem
 * FULL_ROW_FETCH_CONCURRENCY was added to avoid. */
async function fetchFullPeopleByCompanyIds(companyIds: string[]): Promise<FullPersonRow[]> {
  if (companyIds.length === 0) return [];
  const chunks = chunkIds(companyIds, COMPANY_ID_CHUNK_SIZE);
  const rows: FullPersonRow[] = [];
  for (let i = 0; i < chunks.length; i += FULL_ROW_FETCH_CONCURRENCY) {
    const window = chunks.slice(i, i + FULL_ROW_FETCH_CONCURRENCY);
    const results = await Promise.all(
      window.map((chunk) =>
        fetchAllRows<FullPersonRow>("people", FULL_ROW_COLUMNS, (query) => query.in("company_id", chunk))
      )
    );
    rows.push(...results.flat());
  }
  return rows;
}

/** EmailBison push candidates for the Companies-table trigger (ticket #55):
 * resolves the Companies-table's current filters to matching company ids,
 * then loads every Person linked to those companies — there is no
 * company-level EmailBison object (CONTEXT.md's "Companies-table push"
 * glossary entry), so the Companies-table trigger always resolves to running
 * the People-table push logic against every linked Person. A Company with no
 * linked People (or a filter set matching zero Companies) yields an empty
 * array, not an error. Produces the same EmailBisonPushCandidate shape as
 * getPeopleForEmailBison so both entity wrappers converge on one candidate
 * type. */
export async function getPeopleForEmailBisonByCompanyFilters(
  companyFilters: CompanyListFilters
): Promise<EmailBisonPushCandidate[]> {
  const companies = await getAllFilteredCompanies(companyFilters);
  const companyIds = companies.map((c) => c.id);
  if (companyIds.length === 0) return [];

  const rows = sortByLastUpdatedDesc(await fetchFullPeopleByCompanyIds(companyIds));
  return rows.map(toEmailBisonPushCandidate);
}

/** Just the two columns resolveDefaultFieldMapping actually reads to pick the
 * EmailBison company-name default: the person's raw company_name and the
 * linked company's cleaned brand_name. Selected in place of the full `*` row
 * so the default-field-mapping preview never scans every column of the entire
 * filtered set (perf fix — the preview only needs to know whether any record
 * carries a brand_name). */
const COMPANY_NAME_FIELD_COLUMNS = "id, company_name, companies(brand_name)";

interface CompanyNameFieldRow {
  id: string;
  company_name: string | null;
  companies: { brand_name: string | null } | null;
}

/** Narrow (two-column) counterpart to fetchPeopleByIds — same chunking and
 * bounded concurrency, minus the `*` payload. */
async function fetchCompanyNameFieldsByIds(ids: string[]): Promise<CompanyNameFieldRow[]> {
  if (ids.length === 0) return [];
  const chunks = chunkIds(ids, FULL_ROW_ID_CHUNK_SIZE);
  const rows: CompanyNameFieldRow[] = [];
  for (let i = 0; i < chunks.length; i += FULL_ROW_FETCH_CONCURRENCY) {
    const window = chunks.slice(i, i + FULL_ROW_FETCH_CONCURRENCY);
    const results = await Promise.all(
      window.map((chunk) =>
        fetchAllRows<CompanyNameFieldRow>("people", COMPANY_NAME_FIELD_COLUMNS, (query) =>
          query.in("id", chunk)
        )
      )
    );
    rows.push(...results.flat());
  }
  return rows;
}

/** Sentinel row standing in for "at least one record in the pushed set carries
 * a linked-company brand_name". The two getEmailBison…CompanyNameFields loaders
 * below exist only to feed resolveDefaultFieldMapping, which reads exactly one
 * thing out of the array — `records.some(r => !!r.brandName)` (see
 * lib/push/resolve-default-field-mapping.ts). So instead of materializing the
 * whole filtered set's {company_name, brand_name} rows (hundreds of chunked
 * round-trips for a large push — the >1min "Loading default field mapping…"
 * stall this replaces), we answer that boolean with a single short-circuiting
 * existence query and return this one-element sentinel when a brand_name
 * exists, or an empty array when it doesn't. The Promise<PushRecordCompanyNameFields[]>
 * contract is preserved so the route, the shared resolver, and the route test
 * (which mocks these loaders) are untouched. */
const BRAND_NAME_PRESENT_SENTINEL: PushRecordCompanyNameFields[] = [
  { companyName: null, brandName: "x" },
];

/** Company-name/brand-name signal for the current People-table filtered view —
 * the read-only input resolveDefaultFieldMapping needs for the EmailBison
 * default-mapping preview. Returns BRAND_NAME_PRESENT_SENTINEL iff any person in
 * the filtered set has a linked company with a non-null brand_name, else `[]`
 * (see the sentinel comment above for why we don't return the real rows). */
export async function getEmailBisonCompanyNameFields(
  filters: PersonListFilters
): Promise<PushRecordCompanyNameFields[]> {
  const restricted = await resolveRestrictedRows(filters);
  if (restricted !== null) {
    // Restricted dimensions (virtualFilters/pushJobId) already resolved to a
    // bounded id set — cheap to fetch its narrow rows and read brand_name off
    // them. Preserves exact behavior for this small-set path.
    const rows = await fetchCompanyNameFieldsByIds(restricted.map((row) => row.id));
    return rows.some((row) => !!row.companies?.brand_name) ? BRAND_NAME_PRESENT_SENTINEL : [];
  }

  // Hot path (plain PostgREST filters): one short-circuiting existence query
  // for "any filtered person with a linked-company brand_name" via an inner
  // join on companies, filtered to non-null brand_name, capped at one row.
  const { data, error } = await applyPersonFilters(
    supabaseAdmin
      .from("people")
      .select("id, companies!inner(brand_name)")
      .not("companies.brand_name", "is", null),
    filters
  ).limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0 ? BRAND_NAME_PRESENT_SENTINEL : [];
}

/** Companies-table counterpart of getEmailBisonCompanyNameFields — resolves the
 * Companies filters to their linked People (ADR 0003), same as the actual push.
 * Delegates to the single-query existence check in companies.ts; returns
 * BRAND_NAME_PRESENT_SENTINEL iff any filtered company with a linked person
 * carries a non-null brand_name, else `[]`. */
export async function getEmailBisonCompanyNameFieldsByCompanyFilters(
  companyFilters: CompanyListFilters
): Promise<PushRecordCompanyNameFields[]> {
  return (await filteredCompaniesHaveLinkedPersonWithBrandName(companyFilters))
    ? BRAND_NAME_PRESENT_SENTINEL
    : [];
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
    virtualFilters: filters.virtualFilters ?? { combinator: "and", groups: [] },
    pushStatus: pushStatusRpcPayload(filters.pushStatus),
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

/** Live per-status preview counts for the push-status popover (E1, issue #133).
 * Scoped by every *other* active filter (push status is self-excluded — the RPC
 * ignores the pushStatus key), then split into pushed vs not-pushed for the
 * selected client + platform, so `pushed + notPushed` equals the total the
 * filter would yield. Person-level semantics: pushed iff a platform_pushes row
 * exists. Backed by person_push_status_counts (lib/data/push-status-counts.sql);
 * mirrors getCompanyPushStatusCounts. */
export async function getPersonPushStatusCounts(
  filters: PersonListFilters,
  clientId: string,
  platform: PushPlatform
): Promise<PushStatusCounts> {
  const { data, error } = await supabaseAdmin.rpc("person_push_status_counts", {
    filters: toFilterOptionsRpcPayload(filters),
    client_id: clientId,
    platform,
  });
  if (error) throw error;
  const result = data as { pushed: number; notPushed: number };
  return { pushed: result.pushed, notPushed: result.notPushed };
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
