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
   * [min, max] tuple for between, omitted for is_empty/is_not_empty. Text
   * is/is_not additionally accept a `string[]` — the multi-select over a
   * low-cardinality field's real distinct values (ticket #38); the shared SQL
   * predicate treats the array as "matches any of" via jsonb containment.
   * Text and List contains/not_contains additionally accept a `string[]` —
   * the chip input's stacked keywords (ticket #116); "matches any of" for
   * contains, "matches none of" for not_contains. */
  value?: string | number | boolean | string[] | [string | number, string | number] | null;
  /** Which entity's custom_data this condition reads (ticket #30's symmetric
   * cross-table enrichment filtering): 'company' or 'person'. Absent means
   * "the page's own entity" — the pre-#30 behavior, so existing bookmarked
   * `vf` URLs keep parsing and matching identically. */
  source?: "company" | "person";
  /** Only meaningful for a one-to-many cross-table condition (the Companies
   * page filtering by its people's data): 'any' matches a company with at
   * least one qualifying person, 'all' requires every one of its people to
   * qualify. Absent defaults to 'any'. Meaningless (ignored) for a same-table
   * condition or the People page's many-to-one company lookup. */
  quantifier?: "any" | "all";
}

/** Two-level grouped filter logic (ticket #117), matching Clay's nesting
 * depth: conditions combine inside a group with the group's `combinator`
 * (AND/OR), and groups combine at the top with the set's `combinator` — so
 * `(A OR B) AND (C OR D)` is expressible. Depth is fixed at exactly two levels
 * (conditions in groups in a set); the leaf `VirtualColumnFilter` is unchanged.
 * A single AND group of ANDed conditions reproduces the pre-#117 flat-AND
 * behavior exactly (backward compatible — see parseVirtualFiltersParam). */
export type FilterCombinator = "and" | "or";

export interface VirtualFilterGroup {
  combinator: FilterCombinator;
  conditions: VirtualColumnFilter[];
}

export interface VirtualFilterSet {
  combinator: FilterCombinator;
  groups: VirtualFilterGroup[];
}

/** A virtual column added to the Companies/People table for display, distinct
 * from VirtualColumnFilter: a column can be added and rendered before (or
 * without) a filter being applied to it. Carried in the URL as its own `vc`
 * param, separate from `vf`, so "show this field" and "narrow by this field"
 * are independent steps (ticket #34). */
export interface ActiveVirtualColumn {
  key: string;
  type: VirtualColumnType;
  /** Which entity's custom_data this column reads — see VirtualColumnFilter's
   * `source`. Absent means "the page's own entity" (pre-#30 behavior). */
  source?: "company" | "person";
}

/** Operator metadata drives both validation (here) and the operator UI
 * (virtual-columns-bar.tsx). `requiresValue` = one scalar; `requiresRange` =
 * a [min, max] tuple (the `between` operators); neither = a value-less
 * operator (is empty / is not empty, is true / is false). Ticket #34 shipped
 * Text; #35 added Number and Date; #36 adds Boolean and List. The SQL predicate
 * (virtual-columns.sql) already supports all five types — these tables gate
 * what the app is willing to construct and accept back off the URL. */
export interface VirtualColumnOperatorMeta {
  id: VirtualColumnOperator;
  label: string;
  requiresValue?: boolean;
  requiresRange?: boolean;
}

export const TEXT_OPERATORS: VirtualColumnOperatorMeta[] = [
  { id: "is", label: "is", requiresValue: true },
  { id: "is_not", label: "is not", requiresValue: true },
  { id: "contains", label: "contains", requiresValue: true },
  { id: "not_contains", label: "does not contain", requiresValue: true },
  { id: "is_empty", label: "is empty" },
  { id: "is_not_empty", label: "is not empty" },
];

/** Number: `between` carries a [min, max] numeric tuple; the rest a single
 * number. Values are stored as real JSON numbers (not strings) so the SQL
 * `enrichment_numeric(f->'value')` read casts them directly (ticket #35). */
export const NUMBER_OPERATORS: VirtualColumnOperatorMeta[] = [
  { id: "is", label: "is", requiresValue: true },
  { id: "is_not", label: "is not", requiresValue: true },
  { id: "gt", label: "greater than", requiresValue: true },
  { id: "lt", label: "less than", requiresValue: true },
  { id: "between", label: "between", requiresRange: true },
];

/** Date: ISO `YYYY-MM-DD` strings, compared chronologically SQL-side via
 * enrichment_date_text (ticket #35). `between` carries a [from, to] tuple. */
export const DATE_OPERATORS: VirtualColumnOperatorMeta[] = [
  { id: "on", label: "on", requiresValue: true },
  { id: "before", label: "before", requiresValue: true },
  { id: "after", label: "after", requiresValue: true },
  { id: "between", label: "between", requiresRange: true },
];

/** Boolean: value-less — the operator itself is the whole predicate
 * (boolean_filter_matches reads true/false/truthy-string variants SQL-side,
 * ticket #36). */
export const BOOLEAN_OPERATORS: VirtualColumnOperatorMeta[] = [
  { id: "is_true", label: "is true" },
  { id: "is_false", label: "is false" },
];

/** List: array enrichment (e.g. `specialties`). `contains`/`not_contains`
 * match one exact array member via jsonb containment SQL-side
 * (list_filter_matches) — never a substring, so "a3" never also matches
 * "a30" (ticket #36). */
export const LIST_OPERATORS: VirtualColumnOperatorMeta[] = [
  { id: "contains", label: "contains", requiresValue: true },
  { id: "not_contains", label: "does not contain", requiresValue: true },
  { id: "is_empty", label: "is empty" },
  { id: "is_not_empty", label: "is not empty" },
];

/** The types the app can add as columns and filter on. */
const SUPPORTED_TYPES: VirtualColumnType[] = ["text", "number", "date", "boolean", "list"];

export function operatorsForType(type: VirtualColumnType): VirtualColumnOperatorMeta[] {
  switch (type) {
    case "text":
      return TEXT_OPERATORS;
    case "number":
      return NUMBER_OPERATORS;
    case "date":
      return DATE_OPERATORS;
    case "boolean":
      return BOOLEAN_OPERATORS;
    case "list":
      return LIST_OPERATORS;
    default:
      return [];
  }
}

/** Maps an enrichment field's discovered type (lib/data/enrichment-fields.ts)
 * to the VirtualColumnType it becomes as a column — the mapping the table's
 * "Add column" picker uses (tickets #34, #36), reused so a column added from
 * Company Detail's enrichment tab (ticket #39) gets an identical type and
 * therefore identical operators to one added from the table. */
export const ADDABLE_ENRICHMENT_TYPES: Record<string, VirtualColumnType> = {
  Text: "text",
  Number: "number",
  Date: "date",
  Boolean: "boolean",
  List: "list",
};

/** `undefined` when the key wasn't in the discovery sample (or has no
 * addable type) — callers treat that as "no action offered" rather than
 * guessing a type. */
export function addableVirtualColumnType(fieldType: string | undefined): VirtualColumnType | undefined {
  if (!fieldType) return undefined;
  return ADDABLE_ENRICHMENT_TYPES[fieldType];
}

/** Above this many distinct real values, the Text `is` picker keeps free-text
 * matching instead of a multi-select — "only a handful of distinct values"
 * (ticket #38). The discovery RPC caps sampleValues per key at 25, so a field
 * at or below this cap is known to be exhaustively enumerated in the sample
 * (not truncated) — a safe signal that a multi-select would list every real
 * value, not a partial set. */
export const MULTI_SELECT_VALUE_CAP = 12;

/** True when a Text field's distinct real values are few enough to offer as a
 * multi-select of the real values (ticket #38). An empty set means "no known
 * values" → fall back to free-text rather than show an empty picker. */
export function isLowCardinalityTextField(sampleValues: string[]): boolean {
  return sampleValues.length > 0 && sampleValues.length <= MULTI_SELECT_VALUE_CAP;
}

function isNonEmptyKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}/;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isIsoDate(value: unknown): value is string {
  return typeof value === "string" && ISO_DATE.test(value);
}

/** `undefined` is valid (means "the page's own entity") — only a present-but-
 * wrong value is rejected, per the field's backward-compat contract. */
function isValidSource(value: unknown): value is "company" | "person" | undefined {
  return value === undefined || value === "company" || value === "person";
}

/** `undefined` is valid (means "default to 'any'") — see `quantifier` above. */
function isValidQuantifier(value: unknown): value is "any" | "all" | undefined {
  return value === undefined || value === "any" || value === "all";
}

/** Validates the `value` payload against the column type and the operator's
 * arity: text wants a non-empty string, number a finite number (a
 * [min, max] pair for `between`), date an ISO-date string (or pair). A
 * mismatched shape drops the whole filter rather than coercing, so a
 * hand-edited URL can't smuggle a string into a numeric comparison. */
function isValidFilterValue(type: VirtualColumnType, meta: VirtualColumnOperatorMeta, value: unknown): boolean {
  if (meta.requiresRange) {
    if (!Array.isArray(value) || value.length !== 2) return false;
    const [a, b] = value;
    return type === "number" ? isFiniteNumber(a) && isFiniteNumber(b) : isIsoDate(a) && isIsoDate(b);
  }
  if (meta.requiresValue) {
    if (type === "number") return isFiniteNumber(value);
    if (type === "date") return isIsoDate(value);
    // Text is/is_not accept a multi-select value list (ticket #38); Text and
    // List contains/not_contains accept a chip-input keyword list (ticket
    // #116) — both read as a non-empty string[] of non-empty strings. Every
    // other requiresValue operator (List's single-member contains/
    // not_contains form, etc.) stays scalar-only.
    if (
      (meta.id === "is" || meta.id === "is_not" || meta.id === "contains" || meta.id === "not_contains") &&
      Array.isArray(value)
    ) {
      return value.length > 0 && value.every((v) => typeof v === "string" && v.length > 0);
    }
    return typeof value === "string" && value.length > 0;
  }
  return true;
}

/** Accepts text/number/date/boolean/list filters (tickets #34, #35, #36).
 * Each filter is checked against its type's operator table and value arity —
 * anything malformed is dropped by the parser rather than thrown. */
function isValidVirtualColumnFilter(value: unknown): value is VirtualColumnFilter {
  if (typeof value !== "object" || value === null) return false;
  const f = value as Record<string, unknown>;
  if (!isNonEmptyKey(f.key)) return false;
  if (typeof f.type !== "string" || !SUPPORTED_TYPES.includes(f.type as VirtualColumnType)) return false;
  const meta = operatorsForType(f.type as VirtualColumnType).find((o) => o.id === f.operator);
  if (!meta) return false;
  if (!isValidFilterValue(f.type as VirtualColumnType, meta, f.value)) return false;
  if (!isValidSource(f.source)) return false;
  return isValidQuantifier(f.quantifier);
}

export function isValidActiveVirtualColumn(value: unknown): value is ActiveVirtualColumn {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  if (!isNonEmptyKey(c.key) || typeof c.type !== "string" || !SUPPORTED_TYPES.includes(c.type as VirtualColumnType)) {
    return false;
  }
  return isValidSource(c.source);
}

function isCombinator(value: unknown): value is FilterCombinator {
  return value === "and" || value === "or";
}

/** Validates + normalizes one group: drops malformed conditions, and drops
 * the whole group when none survive (an empty group is meaningless — a vacuous
 * AND would match everything, a vacuous OR nothing — so we never carry one). */
function sanitizeGroup(value: unknown): VirtualFilterGroup | null {
  if (typeof value !== "object" || value === null) return null;
  const g = value as Record<string, unknown>;
  if (!Array.isArray(g.conditions)) return null;
  const conditions = g.conditions.filter(isValidVirtualColumnFilter);
  if (conditions.length === 0) return null;
  return { combinator: isCombinator(g.combinator) ? g.combinator : "and", conditions };
}

/** Coerces either the legacy flat `VirtualColumnFilter[]` (interpreted as one
 * AND group, so pre-#117 bookmarked/shared URLs keep working) or the grouped
 * `{combinator, groups}` object into a validated VirtualFilterSet. Malformed
 * conditions and empty groups are dropped rather than thrown; when nothing
 * valid survives the result is `undefined` ("no virtual filter"), consistent
 * with how every other filter param degrades a stale/hand-edited URL. */
export function sanitizeFilterSet(parsed: unknown): VirtualFilterSet | undefined {
  if (Array.isArray(parsed)) {
    const conditions = parsed.filter(isValidVirtualColumnFilter);
    return conditions.length ? { combinator: "and", groups: [{ combinator: "and", conditions }] } : undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const s = parsed as Record<string, unknown>;
  if (!Array.isArray(s.groups)) return undefined;
  const groups = s.groups.map(sanitizeGroup).filter((g): g is VirtualFilterGroup => g !== null);
  return groups.length ? { combinator: isCombinator(s.combinator) ? s.combinator : "and", groups } : undefined;
}

/** Parses the `vf` URL param — a JSON-encoded VirtualFilterSet, or the legacy
 * flat `VirtualColumnFilter[]` (pre-#117), which parses as one AND group so
 * existing bookmarked/shared `/companies?...&vf=[...]` URLs keep working.
 * Shared by the Companies/People pages and their CSV export/Clay push routes,
 * mirroring how parseCompanyFilters/parsePeopleFilters read every other filter.
 * Malformed or invalid entries are dropped rather than thrown, since a
 * hand-edited or stale URL should degrade to "no virtual filter" not error. */
export function parseVirtualFiltersParam(searchParams: URLSearchParams): VirtualFilterSet | undefined {
  const raw = searchParams.get("vf");
  if (!raw) return undefined;
  try {
    return sanitizeFilterSet(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

/** Serializes a VirtualFilterSet to the `vf` param. A single AND group emits
 * the legacy flat `VirtualColumnFilter[]` shape so the common single-group
 * case keeps byte-identical URLs to pre-#117 (backward-compatible bookmarks,
 * minimal diffs); anything with OR or multiple groups emits the grouped
 * object. Returns null for an empty/inactive set (clears the param). */
export function serializeVirtualFiltersParam(set: VirtualFilterSet | null | undefined): string | null {
  if (!set || set.groups.length === 0) return null;
  if (set.groups.length === 1 && set.groups[0].combinator === "and") {
    return set.groups[0].conditions.length ? JSON.stringify(set.groups[0].conditions) : null;
  }
  return JSON.stringify(set);
}

/** Wraps a flat list of conditions as a single AND group — the grouped-set
 * equivalent of the pre-#117 flat array. Handy for callers and tests that just
 * want a simple all-must-match filter without spelling out the group nesting. */
export function filterSet(...conditions: VirtualColumnFilter[]): VirtualFilterSet {
  return { combinator: "and", groups: [{ combinator: "and", conditions }] };
}

/** True when the set carries at least one condition — the "a virtual filter is
 * active" gate the data layer uses to decide whether to resolve the id set at
 * all (an inactive set leaves native filtering behavior unchanged). */
export function isFilterSetActive(set: VirtualFilterSet | null | undefined): boolean {
  return !!set && set.groups.some((g) => g.conditions.length > 0);
}

/** Drops every condition on (source, key) across all groups (used when a
 * display column is removed), pruning any group left empty; returns undefined
 * when no condition remains. `source` is compared as-is (not resolved against
 * a selfEntity) — the caller passes the removed column's own `source`, so a
 * bare (source-absent) column removal only removes bare (source-absent)
 * conditions, matching the pre-#30 behavior exactly. */
export function removeColumnFromFilterSet(
  set: VirtualFilterSet | null | undefined,
  key: string,
  source?: "company" | "person"
): VirtualFilterSet | undefined {
  if (!set) return undefined;
  const groups = set.groups
    .map((g) => ({ ...g, conditions: g.conditions.filter((c) => !(c.key === key && c.source === source)) }))
    .filter((g) => g.conditions.length > 0);
  return groups.length ? { ...set, groups } : undefined;
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

/** Composite identity for a filter/column: (source, key) rather than key
 * alone, since ticket #30 lets a page carry conditions/columns against both
 * its own entity and the other table's — "lead_score" on companies and
 * "lead_score" on people are different fields that must not collide when
 * deduping or matching. `source` absent resolves to `selfEntity` (the page's
 * own entity), matching every other absent-source fallback in this file. */
export function virtualColumnIdentity(
  source: "company" | "person" | undefined,
  key: string,
  selfEntity: "company" | "person"
): string {
  return `${source ?? selfEntity}:${key}`;
}
