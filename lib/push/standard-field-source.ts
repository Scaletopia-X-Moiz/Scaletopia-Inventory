/** Shared encoding for a standard-field mapping value that is a user-typed
 * *static value* rather than a bound source column.
 *
 * Standard-field mappings (EmailBisonStandardFieldMapping, GhlStandardFieldMapping)
 * store one flat string per destination field: either "skip", a source-column
 * key (e.g. "firstName", "brandName", or a virtual/enrichment column key), or —
 * added here — a static value the user types once and which is sent verbatim to
 * every pushed contact. Rather than widen the mapping type to an object (which
 * would break the string-based storage, normalization, and in-flight queued
 * jobs), a static value is encoded inline with the LITERAL_PREFIX: the stored
 * string "literal:VIP" means "send the text 'VIP' to this field for everyone".
 * This mirrors the literal/column duality the custom-variable editor already
 * offers (EmailBisonCustomVariableEntry, GhlFieldMapping), surfaced in the UI
 * as a "Static value" option.
 *
 * The prefix is an internal encoding, not a user-facing label, and cannot
 * collide with a real column key: the mode is only ever produced by the
 * "Static value" dropdown option, never inferred from a column key that merely
 * happens to start with the prefix — the UI select emits LITERAL_SENTINEL and
 * the resolver only decodes strings this module encoded. */

/** Stored-string prefix marking the rest of the value as static text. */
export const LITERAL_PREFIX = "literal:";

/** The `<select>` option value used for the "Static value" mode. Distinct from
 * the stored encoding so the dropdown never has to round-trip the typed text
 * through its option list. */
export const LITERAL_SENTINEL = "__literal__";

/** True when a standard-field mapping value encodes a static value. */
export function isLiteralSource(value: string): boolean {
  return value.startsWith(LITERAL_PREFIX);
}

/** Decodes the typed text out of a static-value mapping string. Returns "" for
 * a bare prefix (static mode selected, nothing typed yet). */
export function literalSourceText(value: string): string {
  return value.slice(LITERAL_PREFIX.length);
}

/** Encodes user-typed text into a static-value mapping string. */
export function toLiteralSource(text: string): string {
  return LITERAL_PREFIX + text;
}
