import type {
  GhlContactPayloadShape,
  GhlFieldMapping,
  GhlPushRecord,
  GhlStandardFieldMapping,
} from "@/lib/ghl/types";
import { resolveMappedValue } from "@/lib/push/resolve-mapped-value";
import { isLiteralSource, literalSourceText } from "@/lib/push/standard-field-source";

/** Maps a bindable "People-table column" name (offered in the GHL push
 * mapping step, ticket #142) to the matching GhlPushRecord field — the
 * standard-column half of a column-bound custom-field entry. Mirrors
 * EmailBison's KNOWN_RECORD_FIELDS (lib/emailbison/lead-payload.ts) but over
 * GHL's own field set: shared fields (firstName/lastName/email/phone/
 * companyName/brandName) plus GHL-only city/country/niche/employeeCount/
 * source. A columnKey that isn't one of these falls through to custom_data
 * (a virtual/enrichment column) in resolveGhlColumnValue. */
export const GHL_KNOWN_RECORD_FIELDS: Record<string, keyof GhlPushRecord> = {
  firstName: "firstName",
  lastName: "lastName",
  email: "email",
  phone: "phone",
  companyName: "companyName",
  brandName: "brandName",
  city: "city",
  country: "country",
  niche: "niche",
  employeeCount: "employeeCount",
  source: "source",
  // Remaining person-own real columns (ground-truth audit, 2026-08-15).
  title: "title",
  website: "website",
  state: "state",
  fullName: "fullName",
  linkedinUrl: "linkedinUrl",
  linkedinUsername: "linkedinUsername",
  phoneType: "phoneType",
  phoneStatus: "phoneStatus",
  emailStatus: "emailStatus",
  sourceId: "sourceId",
  tags: "tags",
  emailVerifiedAt: "emailVerifiedAt",
  phoneVerifiedAt: "phoneVerifiedAt",
  lastUpdated: "lastUpdated",
  createdAt: "createdAt",
  // Linked company's real columns (company* namespace — resolved from the
  // company embed). See GhlPushRecord's doc comment for why
  // companyEmployeeCount/companyNiche/companySource are deliberately absent.
  companyCity: "companyCity",
  companyState: "companyState",
  companyCountry: "companyCountry",
  companyIndustry: "companyIndustry",
  companyWebsiteUrl: "companyWebsiteUrl",
  companyLinkedinUrl: "companyLinkedinUrl",
  companyDomain: "companyDomain",
  companyPhone: "companyPhone",
  companyPhoneType: "companyPhoneType",
  companyPhoneStatus: "companyPhoneStatus",
  companyEmail: "companyEmail",
  companyEmailStatus: "companyEmailStatus",
  companyEmailVerifiedAt: "companyEmailVerifiedAt",
  companyPhoneVerifiedAt: "companyPhoneVerifiedAt",
  companyQualityTier: "companyQualityTier",
  companyClient: "companyClient",
  companyDescription: "companyDescription",
  companyFoundedYear: "companyFoundedYear",
  companyRevenue: "companyRevenue",
  companyDomainStatus: "companyDomainStatus",
  companyMxProvider: "companyMxProvider",
  companySecurityGateway: "companySecurityGateway",
  companyKeywords: "companyKeywords",
  companyTechnologies: "companyTechnologies",
  companyTags: "companyTags",
  companyCreatedAt: "companyCreatedAt",
  companyLastUpdated: "companyLastUpdated",
};

/** Resolves a column-bound entry's raw value against one candidate's
 * GhlPushRecord + custom_data — a pure key lookup. Unlike the pre-free-source
 * mapping version of this function, this has no companyName-prefers-brandName
 * special case: "companyName" means the raw value and "brandName" means the
 * cleaned one, each addressable independently now that the standard-field
 * mapping is free-source (a caller that wants the clean-name-preferred
 * default gets it from buildGhlContactPayload's own defaultValue, not from
 * here) — mirrors EmailBison's resolveEmailBisonColumnValue
 * (lib/emailbison/lead-payload.ts). */
function resolveGhlColumnValue(
  columnKey: string,
  record: GhlPushRecord | undefined,
  customData: Record<string, unknown> | null
): unknown {
  const recordField = GHL_KNOWN_RECORD_FIELDS[columnKey];
  if (recordField && record) return record[recordField];
  return customData?.[columnKey] ?? null;
}

/** Maps a legacy saved standard-field value to this feature's current
 * source-key shape, so old push_field_mappings rows and already-queued
 * push_jobs keep resolving correctly after the include/skip → free-source
 * rework: "include" meant "send this field from its own record column",
 * which is exactly what sourcing the field from its own key now means, so it
 * maps to `field` itself; "brand_name"/"company_name" were the old 3-way
 * companyName enum's other two values. "skip" and any value that's already a
 * source key pass through unchanged. Mirrors EmailBison's
 * normalizeFieldSource (lib/emailbison/lead-payload.ts). */
export function normalizeGhlFieldSource(field: keyof GhlStandardFieldMapping, value: string): string {
  if (value === "include") return field;
  if (value === "brand_name") return "brandName";
  if (value === "company_name") return "companyName";
  return value;
}

/** Resolves one standard field's outbound value: an omitted mapping (or a
 * field missing from an older-shaped mapping) falls back to `defaultValue`
 * — the caller's today's-behavior default — so buildGhlContactPayload's
 * unmapped path is byte-for-byte what it was before free-source mapping
 * existed. Otherwise the (possibly legacy) value is normalized via
 * normalizeGhlFieldSource, "skip" sends null, and anything else is resolved
 * against the record/custom_data and stringified via
 * stringifyCustomFieldValue — mirrors EmailBison's resolveStandardField
 * (lib/emailbison/lead-payload.ts). */
function resolveStandardField(
  field: keyof GhlStandardFieldMapping,
  defaultValue: string | null,
  mapping: GhlStandardFieldMapping | undefined,
  record: GhlPushRecord,
  customData: Record<string, unknown> | null
): string | null {
  const raw = mapping?.[field];
  if (raw === undefined) return defaultValue;
  const source = normalizeGhlFieldSource(field, raw);
  if (source === "skip") return null;
  // A static value ("literal:<text>") is sent verbatim to every contact —
  // the standard-field twin of a literal custom-field entry. Decoded here
  // before any column lookup so the typed text is never resolved as a column
  // key.
  if (isLiteralSource(source)) return literalSourceText(source);
  // companyName sourced from brandName keeps the old 3-way "brand_name"
  // choice's brand-preferred-with-raw-fallback semantics: the default mapping
  // (and any normalized-legacy "brand_name") sends companyName: "brandName"
  // for the *whole* push whenever any record has a cleaned name, so a
  // brand-less record in that set must still fall back to its raw
  // companyName rather than send null — otherwise, with brand_name coverage
  // ~0.2%, a mixed push would blank out company name for nearly every
  // contact. brandName stays a strict lookup everywhere else (custom fields,
  // other standard fields), where "no cleaned name" correctly resolves to
  // null.
  if (field === "companyName" && source === "brandName") {
    return stringifyCustomFieldValue(record.brandName || record.companyName);
  }
  return stringifyCustomFieldValue(resolveGhlColumnValue(source, record, customData));
}

/** Shapes a person record into a GHL contact-creation payload. Tags are
 * supplied by the caller rather than derived here, since a single push can
 * attach more than one tag to a contact. `customFields` is likewise
 * pre-built by the caller (via buildGhlCustomFields) — this function just
 * carries it through, defaulting to empty when the push has no active field
 * mapping (ticket #51).
 *
 * `customData` is the candidate's raw enrichment data (mirrors the same
 * argument on buildGhlCustomFields) — needed here too now that a standard
 * field can be free-sourced from a virtual/enrichment column, not just a
 * fixed record field. `record` is the full GhlPushRecord (not a narrowed
 * Pick) for the same reason — a standard field can now be sourced from
 * niche/employeeCount/source too.
 *
 * `standardFieldMapping` (ticket #109, reworked to free-source mapping) lets
 * the caller override which column feeds each standard field — omitting it,
 * or omitting an individual field within it, reproduces today's behavior
 * exactly: prefer brand_name for companyName, include every other field from
 * its own record column. */
export function buildGhlContactPayload(
  record: GhlPushRecord,
  customData: Record<string, unknown> | null,
  tags: string[],
  customFields: { id: string; value: string }[] = [],
  standardFieldMapping?: GhlStandardFieldMapping
): GhlContactPayloadShape {
  return {
    firstName: resolveStandardField("firstName", record.firstName, standardFieldMapping, record, customData),
    lastName: resolveStandardField("lastName", record.lastName, standardFieldMapping, record, customData),
    email: resolveStandardField("email", record.email, standardFieldMapping, record, customData),
    phone: resolveStandardField("phone", record.phone, standardFieldMapping, record, customData),
    companyName: resolveStandardField(
      "companyName",
      record.brandName || record.companyName,
      standardFieldMapping,
      record,
      customData
    ),
    city: resolveStandardField("city", record.city, standardFieldMapping, record, customData),
    country: resolveStandardField("country", record.country, standardFieldMapping, record, customData),
    tags,
    customFields,
  };
}

/** Stringifies one column-sourced value for GHL's text-only custom-field API,
 * or reports "nothing to send" (null) — matching how the rest of the push
 * treats missing/empty source data as "omit" rather than "send blank".
 * List-type enrichment columns (lib/data/virtual-columns.ts) store a JSON
 * array — joined with ", " explicitly rather than relying on Array's
 * implicit toString (which is equivalent but easy to misread as a bug at the
 * call site) so a mapped list column reads as "a, b, c" rather than "a,b,c".
 * CRITICAL: keep this join-with-", " — EmailBison's equivalent
 * (stringifyCustomValue, lib/emailbison/lead-payload.ts) JSON-encodes arrays
 * instead, and the two must not converge (that'd be an observable wire-format
 * regression for whichever platform changed). */
function stringifyCustomFieldValue(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return value.map(String).join(", ");
  }
  return String(value);
}

/** Resolves a mapping step's chosen entries (ticket #51, literal/column
 * duality added by #142) against one candidate's record + custom_data,
 * producing the `{id, value}` entries GHL expects on `customFields`. A
 * literal entry sends its value verbatim; a column entry is dropped (not
 * sent as an empty string) when its source data is missing/empty — see
 * stringifyCustomFieldValue. `record` is optional so existing column-only
 * callers/tests that only exercise custom_data-backed columns keep working
 * (a columnKey with no record and no known-field match just falls through to
 * custom_data, same as before). */
export function buildGhlCustomFields(
  customData: Record<string, unknown> | null,
  mapping: GhlFieldMapping[],
  record?: GhlPushRecord
): { id: string; value: string }[] {
  if (mapping.length === 0) return [];

  const fields: { id: string; value: string }[] = [];
  for (const entry of mapping) {
    const value = resolveMappedValue(
      entry,
      (columnKey) => resolveGhlColumnValue(columnKey, record, customData),
      stringifyCustomFieldValue
    );
    if (value === null) continue;
    fields.push({ id: entry.ghlFieldId, value });
  }
  return fields;
}
