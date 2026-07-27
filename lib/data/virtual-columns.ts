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
