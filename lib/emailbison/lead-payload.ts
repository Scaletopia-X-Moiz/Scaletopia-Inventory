import type {
  EmailBisonCustomVariableEntry,
  EmailBisonLeadPayload,
  EmailBisonPushRecord,
  EmailBisonStandardFieldMapping,
} from "@/lib/emailbison/types";
import { resolveMappedValue } from "@/lib/push/resolve-mapped-value";
import { isLiteralSource, literalSourceText } from "@/lib/push/standard-field-source";

/** Maps a bindable "People-table column" name (as offered in the Add-to-
 * EmailBison row-adder, issue #52/#61, and in the standard-field mapping's
 * free-source dropdowns) to the matching EmailBisonPushRecord field — the
 * standard-column half of a column-bound custom-variable entry. `brandName`
 * resolves to the cleaned company name (companies.brand_name) distinct from
 * `companyName`'s raw one. A columnKey that isn't one of these falls through
 * to custom_data (an enrichment/virtual column) in resolveCustomVariables. */
const KNOWN_RECORD_FIELDS: Record<string, keyof EmailBisonPushRecord> = {
  firstName: "firstName",
  lastName: "lastName",
  email: "email",
  phone: "phone",
  companyName: "companyName",
  brandName: "brandName",
  title: "title",
  website: "website",
  // Person's own real columns (plain keys — resolved from the person row).
  city: "city",
  state: "state",
  country: "country",
  fullName: "fullName",
  linkedinUrl: "linkedinUrl",
  linkedinUsername: "linkedinUsername",
  phoneType: "phoneType",
  phoneStatus: "phoneStatus",
  emailStatus: "emailStatus",
  sourceId: "sourceId",
  // Linked company's real columns (company* namespace — resolved from the
  // company embed). Distinct from the person's own same-named fields above.
  companyCity: "companyCity",
  companyState: "companyState",
  companyCountry: "companyCountry",
  companyIndustry: "companyIndustry",
  companyEmployeeCount: "companyEmployeeCount",
  companyWebsiteUrl: "companyWebsiteUrl",
  companyLinkedinUrl: "companyLinkedinUrl",
  companyDomain: "companyDomain",
  companyPhone: "companyPhone",
  companyPhoneType: "companyPhoneType",
  companyEmail: "companyEmail",
  companyEmailStatus: "companyEmailStatus",
  companyNiche: "companyNiche",
  companyQualityTier: "companyQualityTier",
};

/** String-ifies a resolved column value for the wire (EmailBison custom
 * variables are name/value string pairs, per lib/emailbison/types.ts).
 * Objects/arrays (e.g. a List virtual column) are JSON-encoded rather than
 * dropped, so a non-scalar enrichment value still reaches EmailBison as
 * readable text. null/undefined signal "nothing to send" to the caller, not
 * an empty string — sending "null" would be worse than omitting the variable
 * for that record. */
function stringifyCustomValue(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return null;
  }
}

/** Resolves a column-bound entry's raw value against one candidate's
 * EmailBisonPushRecord + custom_data — a pure key lookup. Unlike GHL's
 * resolveGhlColumnValue (lib/ghl/contact-payload.ts), this has no
 * companyName-prefers-brandName special case: "companyName" means the raw
 * value and "brandName" means the cleaned one, each addressable
 * independently now that the standard-field mapping is free-source (a caller
 * that wants the clean-name-preferred default gets it from
 * buildEmailBisonLeadPayload's own defaultValue, not from here). */
function resolveEmailBisonColumnValue(
  columnKey: string,
  record: EmailBisonPushRecord,
  customData: Record<string, unknown> | null
): unknown {
  const recordField = KNOWN_RECORD_FIELDS[columnKey];
  return recordField ? record[recordField] : (customData?.[columnKey] ?? null);
}

/** Resolves each custom-variable entry against one candidate's data: a
 * literal entry (no `columnKey`) passes through untouched; a column-bound
 * entry reads the matching EmailBisonPushRecord field or, failing that, the
 * candidate's raw custom_data (a virtual/enrichment column) — issue #61's
 * "bound to a People-table column or virtual column" requirement. An entry
 * that resolves to null/undefined (missing enrichment data for this
 * particular record) is dropped rather than sent as an empty string, so one
 * record's missing field doesn't send a misleading blank value to EmailBison.
 * Called once per candidate, not once per push, since the resolved value
 * differs per record. Shares its resolve/stringify algorithm with GHL's
 * buildGhlCustomFields via lib/push/resolve-mapped-value.ts — this function
 * keeps stringifyCustomValue's JSON-encode-arrays behavior as its stringify
 * strategy, distinct from GHL's join-with-", ". */
export function resolveCustomVariables(
  entries: EmailBisonCustomVariableEntry[],
  record: EmailBisonPushRecord,
  customData: Record<string, unknown> | null
): EmailBisonCustomVariableEntry[] {
  const resolved: EmailBisonCustomVariableEntry[] = [];
  for (const entry of entries) {
    if (!entry.columnKey) {
      resolved.push(entry);
      continue;
    }

    const value = resolveMappedValue(
      entry,
      (columnKey) => resolveEmailBisonColumnValue(columnKey, record, customData),
      stringifyCustomValue
    );
    if (value === null) continue;
    resolved.push({ name: entry.name, value });
  }
  return resolved;
}

/** Maps a legacy saved standard-field value to this feature's current
 * source-key shape, so old push_field_mappings rows and already-queued
 * push_jobs keep resolving correctly after the include/skip → free-source
 * rework: "include" meant "send this field from its own record column",
 * which is exactly what sourcing the field from its own key now means, so it
 * maps to `field` itself; "brand_name"/"company_name" were the old 3-way
 * companyName enum's other two values. "skip" and any value that's already a
 * source key pass through unchanged. */
export function normalizeFieldSource(field: keyof EmailBisonStandardFieldMapping, value: string): string {
  if (value === "include") return field;
  if (value === "brand_name") return "brandName";
  if (value === "company_name") return "companyName";
  return value;
}

/** Resolves one standard field's outbound value: an omitted mapping (or a
 * field missing from an older-shaped mapping) falls back to `defaultValue`
 * — the caller's today's-behavior default — so buildEmailBisonLeadPayload's
 * unmapped path is byte-for-byte what it was before free-source mapping
 * existed. Otherwise the (possibly legacy) value is normalized via
 * normalizeFieldSource, "skip" sends null, and anything else is resolved
 * against the record/custom_data and stringified — the same resolve+
 * stringify pipeline resolveCustomVariables uses for custom-variable rows. */
function resolveStandardField(
  field: keyof EmailBisonStandardFieldMapping,
  defaultValue: string | null,
  mapping: EmailBisonStandardFieldMapping | undefined,
  record: EmailBisonPushRecord,
  customData: Record<string, unknown> | null
): string | null {
  const raw = mapping?.[field];
  if (raw === undefined) return defaultValue;
  const source = normalizeFieldSource(field, raw);
  if (source === "skip") return null;
  // A static value ("literal:<text>") is sent verbatim to every contact —
  // the standard-field twin of a literal custom-variable entry. Decoded here
  // before any column lookup so the typed text is never resolved as a column
  // key.
  if (isLiteralSource(source)) return literalSourceText(source);
  // companyName sourced from brandName keeps the old 3-way "brand_name"
  // choice's brand-preferred-with-raw-fallback semantics: the default mapping
  // (and any normalized-legacy "brand_name") sends companyName: "brandName"
  // for the *whole* push whenever any record has a cleaned name, so a
  // brand-less record in that set must still fall back to its raw
  // companyName rather than send null — otherwise, with brand_name coverage
  // ~0.2%, a mixed push would blank out company name for nearly every lead.
  // brandName stays a strict lookup everywhere else (custom variables, other
  // standard fields), where "no cleaned name" correctly resolves to null.
  if (field === "companyName" && source === "brandName") {
    return stringifyCustomValue(record.brandName || record.companyName);
  }
  return stringifyCustomValue(resolveEmailBisonColumnValue(source, record, customData));
}

/** Shapes a person record into an EmailBison lead upsert payload, mirroring
 * buildGhlContactPayload (lib/ghl/contact-payload.ts). Custom-variable
 * entries are supplied pre-resolved by the caller (literal value already
 * typed in, or a bound column already looked up via resolveCustomVariables)
 * — this function just carries them through onto `customVariables`,
 * defaulting to empty when the push has no entries selected.
 *
 * `customData` is the candidate's raw enrichment data (mirrors the same
 * argument on resolveCustomVariables) — needed here too now that a standard
 * field can be free-sourced from a virtual/enrichment column, not just a
 * fixed record field. Required (no default) so every call site is forced to
 * pass it explicitly rather than silently shifting the other positional args.
 *
 * `standardFieldMapping` (issue #110, reworked to free-source mapping) lets
 * the caller override which column feeds each standard field — omitting it,
 * or omitting an individual field within it, reproduces today's behavior
 * exactly: prefer brand_name for companyName, include every other field from
 * its own record column. */
export function buildEmailBisonLeadPayload(
  record: EmailBisonPushRecord,
  customData: Record<string, unknown> | null,
  customVariables: EmailBisonCustomVariableEntry[] = [],
  existingLeadBehavior: "patch" | "put" = "patch",
  standardFieldMapping?: EmailBisonStandardFieldMapping
): EmailBisonLeadPayload {
  return {
    email: resolveStandardField("email", record.email, standardFieldMapping, record, customData),
    firstName: resolveStandardField("firstName", record.firstName, standardFieldMapping, record, customData),
    lastName: resolveStandardField("lastName", record.lastName, standardFieldMapping, record, customData),
    companyName: resolveStandardField(
      "companyName",
      record.brandName || record.companyName,
      standardFieldMapping,
      record,
      customData
    ),
    title: resolveStandardField("title", record.title, standardFieldMapping, record, customData),
    phone: resolveStandardField("phone", record.phone, standardFieldMapping, record, customData),
    website: resolveStandardField("website", record.website, standardFieldMapping, record, customData),
    existingLeadBehavior,
    customVariables: customVariables.map(({ name, value }) => ({ name, value })),
  };
}
