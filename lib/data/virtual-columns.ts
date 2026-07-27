/** Types for a virtual-column filter over one `custom_data` enrichment field.
 * See docs/adr/0002-virtual-column-enrichment-filtering.md and ticket #33 —
 * this is the shape carried on CompanyListFilters/PersonListFilters and
 * serialized straight to the shared SQL predicate (lib/data/virtual-columns.sql).
 * No operator UI exists yet; this ticket only wires the seam. */

export type VirtualColumnType = "text" | "number" | "boolean" | "list" | "date";

export type VirtualColumnOperator =
  | "is"
  | "is_not"
  | "contains"
  | "not_contains"
  | "is_empty"
  | "is_not_empty"
  | "gt"
  | "lt"
  | "between"
  | "is_true"
  | "is_false"
  | "on"
  | "before"
  | "after";

export interface VirtualColumnFilter {
  /** The custom_data key this filter reads, e.g. "lead_score". */
  key: string;
  type: VirtualColumnType;
  operator: VirtualColumnOperator;
  /** Shape depends on type/operator: a scalar for is/gt/lt/contains, a
   * [min, max] tuple for between, omitted for is_empty/is_not_empty. */
  value?: string | number | boolean | [string | number, string | number] | null;
}

/** A virtual column added to the Companies/People table for display, distinct
 * from VirtualColumnFilter: a column can be added and rendered before (or
 * without) a filter being applied to it. Carried in the URL as its own `vc`
 * param, separate from `vf`, so "show this field" and "narrow by this field"
 * are independent steps (ticket #34). */
export interface ActiveVirtualColumn {
  key: string;
  type: VirtualColumnType;
}

/** Text operators wired up by ticket #34 — the only type with operator UI so
 * far. #35 (Number/Date) and #36 (Boolean/List) add their own operator sets
 * alongside this one; the SQL predicate (virtual-columns.sql) already
 * supports all five types. */
export const TEXT_OPERATORS: { id: VirtualColumnOperator; label: string; requiresValue: boolean }[] = [
  { id: "is", label: "is", requiresValue: true },
  { id: "is_not", label: "is not", requiresValue: true },
  { id: "contains", label: "contains", requiresValue: true },
  { id: "not_contains", label: "does not contain", requiresValue: true },
  { id: "is_empty", label: "is empty", requiresValue: false },
  { id: "is_not_empty", label: "is not empty", requiresValue: false },
];

const TEXT_OPERATOR_IDS = new Set(TEXT_OPERATORS.map((o) => o.id));

function isNonEmptyKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

/** Only accepts type "text" for now — matches what the UI can actually
 * produce (ticket #34). Loosen alongside #35/#36 as their operator sets land. */
function isValidVirtualColumnFilter(value: unknown): value is VirtualColumnFilter {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  if (!isNonEmptyKey(f.key)) return false;
  if (f.type !== "text") return false;
  if (typeof f.operator !== "string" || !TEXT_OPERATOR_IDS.has(f.operator as VirtualColumnOperator)) return false;
  const requiresValue = TEXT_OPERATORS.find((o) => o.id === f.operator)?.requiresValue;
  return requiresValue ? typeof f.value === "string" && f.value.length > 0 : true;
}

function isValidActiveVirtualColumn(value: unknown): value is ActiveVirtualColumn {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return isNonEmptyKey(c.key) && c.type === "text";
}

/** Parses the `vf` URL param (a JSON-encoded VirtualColumnFilter[]) shared by
 * the Companies page and its CSV export/Clay push routes, mirroring how
 * parseCompanyFilters/parsePeopleFilters read every other filter. Malformed
 * or invalid entries are dropped rather than thrown, since a hand-edited or
 * stale URL should degrade to "no virtual filter" rather than error the page. */
export function parseVirtualFiltersParam(searchParams: URLSearchParams): VirtualColumnFilter[] | undefined {
  const raw = searchParams.get("vf");
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return undefined;
    const valid = parsed.filter(isValidVirtualColumnFilter);
    return valid.length ? valid : undefined;
  } catch {
    return undefined;
  }
}

export function serializeVirtualFiltersParam(filters: VirtualColumnFilter[]): string | null {
  return filters.length ? JSON.stringify(filters) : null;
}

/** Parses the `vc` URL param (a JSON-encoded ActiveVirtualColumn[]) — the set
 * of enrichment fields currently added as display columns, independent of
 * whether each one also has an active `vf` filter. */
export function parseVirtualColumnsParam(searchParams: URLSearchParams): ActiveVirtualColumn[] {
  const raw = searchParams.get("vc");
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidActiveVirtualColumn);
  } catch {
    return [];
  }
}

export function serializeVirtualColumnsParam(columns: ActiveVirtualColumn[]): string | null {
  return columns.length ? JSON.stringify(columns) : null;
}
