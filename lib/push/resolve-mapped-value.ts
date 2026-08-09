/** Shared algorithm behind GHL's buildGhlCustomFields (lib/ghl/contact-payload.ts)
 * and EmailBison's resolveCustomVariables (lib/emailbison/lead-payload.ts):
 * resolve one mapping entry — literal or column-bound — against a single
 * pushed candidate. Deliberately generic over the record type: callers close
 * over their own record/custom_data lookup (including any special-cased
 * fields, e.g. companyName preferring brand_name) rather than this module
 * knowing either platform's field set. The two platforms differ in how they
 * stringify a resolved value (GHL joins arrays with ", ", EmailBison
 * JSON-encodes them) — `stringify` is a parameter specifically so a shared
 * refactor can't accidentally homogenize that. */

export interface MappedEntry {
  /** "literal" always short-circuits to `value`. Column-bound entries with no
   * explicit source (EmailBison's entries predate this field) are inferred
   * from `columnKey` being set. */
  source?: "literal" | "column";
  columnKey?: string;
  value?: string | null;
}

/** Resolves one entry: a literal passes `value` through untouched (null/undefined
 * become null — "skip", not "send empty"); a column-bound entry looks up its
 * value via `resolveColumnValue` and stringifies it. Returns null when there's
 * nothing to send — a missing columnKey, or `stringify` reporting "no value"
 * (e.g. null/undefined/empty-array source data). */
export function resolveMappedValue(
  entry: MappedEntry,
  resolveColumnValue: (columnKey: string) => unknown,
  stringify: (value: unknown) => string | null
): string | null {
  const isLiteral = entry.source === "literal" || (entry.source === undefined && !entry.columnKey);
  if (isLiteral) return entry.value ?? null;
  if (!entry.columnKey) return null;
  return stringify(resolveColumnValue(entry.columnKey));
}
