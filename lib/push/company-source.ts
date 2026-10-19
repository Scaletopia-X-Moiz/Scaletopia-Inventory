/** Binding a People-push field to the linked company's custom_data
 * (enrichment) key, shared by the GHL and EmailBison people pushes.
 *
 * A push binding is just a string key — a record field name ("firstName"),
 * or a person custom_data key. That string is what the dialogs' <select>s
 * emit, what push_field_mappings persists, and what a queued
 * push_jobs.options carries, so the company-source marker is encoded inline
 * with COMPANY_CUSTOM_PREFIX rather than widening those shapes (same
 * approach as LITERAL_PREFIX in lib/push/standard-field-source.ts). A key with
 * no prefix resolves exactly as it always did (record field, else person
 * custom_data), so saved mappings and in-flight jobs are unaffected.
 *
 * The prefix also keeps the two sources distinct on a key collision: a key
 * present on both people.custom_data and companies.custom_data is offered
 * twice ("key" vs "company_custom:key"), and a company key that happens to
 * equal a record field name (e.g. "city") is never shadowed by that field. */

/** Stored-key prefix marking the rest as a linked-company custom_data key. */
export const COMPANY_CUSTOM_PREFIX = "company_custom:";

export function isCompanyCustomKey(columnKey: string): boolean {
  return columnKey.startsWith(COMPANY_CUSTOM_PREFIX);
}

/** The bare custom_data key out of a company-source binding. */
export function companyCustomKeyName(columnKey: string): string {
  return columnKey.slice(COMPANY_CUSTOM_PREFIX.length);
}

export function toCompanyCustomKey(key: string): string {
  return COMPANY_CUSTOM_PREFIX + key;
}

/** Reads a company-source binding's value off the linked company's
 * custom_data. Null when the person has no linked company, or the company
 * has no such key. */
export function resolveCompanyCustomValue(
  columnKey: string,
  companyCustomData: Record<string, unknown> | null | undefined
): unknown {
  return companyCustomData?.[companyCustomKeyName(columnKey)] ?? null;
}

/** True when any of the given binding keys reads company custom_data — lets
 * the people loaders skip embedding companies.custom_data (a large blob per
 * person row) for a push that doesn't bind any company field. */
export function usesCompanyCustomData(columnKeys: Iterable<string | null | undefined>): boolean {
  for (const key of columnKeys) {
    if (typeof key === "string" && isCompanyCustomKey(key)) return true;
  }
  return false;
}

/** One option in a push dialog's column dropdown. `group: "company"` renders
 * under a "Company fields" heading and is bound via toCompanyCustomKey. */
export interface BindableColumn {
  key: string;
  label: string;
  group?: "company";
}

/** Builds the dropdown options for a People push dialog: the record columns,
 * then active virtual columns and discovered person custom_data keys (deduped
 * by key, as before), then company custom_data keys under their own group.
 * Company options are deduped by source+key, not key alone — a key present on
 * both tables stays a separate, prefixed option. An active virtual column
 * whose `source` is "company" is bound to the company, not the person. */
export function buildPeoplePushBindableColumns(
  recordColumns: { key: string; label: string }[],
  virtualColumns: { key: string; source?: "company" | "person" }[],
  personFields: { key: string }[],
  companyFields: { key: string }[]
): BindableColumn[] {
  const columns: BindableColumn[] = [...recordColumns];
  const seen = new Set(columns.map((c) => c.key));
  const companyKeys: string[] = [];

  const addPerson = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    columns.push({ key, label: key });
  };
  const addCompany = (key: string) => {
    const bound = toCompanyCustomKey(key);
    if (seen.has(bound)) return;
    seen.add(bound);
    companyKeys.push(key);
  };

  for (const c of virtualColumns) {
    if (c.source === "company") addCompany(c.key);
    else addPerson(c.key);
  }
  for (const f of personFields) addPerson(f.key);
  for (const f of companyFields) addCompany(f.key);

  for (const key of companyKeys) {
    columns.push({ key: toCompanyCustomKey(key), label: key, group: "company" });
  }
  return columns;
}

/** Query string for company enrichment discovery
 * (/api/companies/enrichment-fields) from a People page's filter params.
 * Only the facets that mean the same thing on a company are carried over —
 * people-only filters (phoneType, emailStatus, title, push status, ...) would
 * make company discovery match nothing, and company discovery samples a
 * bounded set, so the niche/industry/country/employee scope is what keeps it
 * landing on the relevant companies. */
const SHARED_COMPANY_PARAMS = new Set([
  "niche",
  "niche_exclude",
  "industry",
  "industry_exclude",
  "country",
  "country_exclude",
  "employee",
  "empmin",
  "empmax",
]);

export function toCompanyDiscoveryParams(paramsStr: string): string {
  const out = new URLSearchParams();
  for (const [key, value] of new URLSearchParams(paramsStr)) {
    if (SHARED_COMPANY_PARAMS.has(key)) out.append(key, value);
  }
  return out.toString();
}
