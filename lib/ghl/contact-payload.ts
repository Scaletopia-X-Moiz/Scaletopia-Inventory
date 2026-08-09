import type {
  GhlContactPayloadShape,
  GhlFieldMapping,
  GhlPushRecord,
  GhlStandardFieldMapping,
} from "@/lib/ghl/types";
import { resolveMappedValue } from "@/lib/push/resolve-mapped-value";

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
};

/** Resolves a column-bound entry's raw value against one candidate's
 * GhlPushRecord + custom_data. companyName gets the same clean-name
 * preference as buildGhlContactPayload, so a custom field bound to "Company
 * name" isn't left sending the raw value — mirrors EmailBison's
 * resolveCustomVariables special case. */
function resolveGhlColumnValue(
  columnKey: string,
  record: GhlPushRecord | undefined,
  customData: Record<string, unknown> | null
): unknown {
  if (columnKey === "companyName") {
    return record ? record.brandName || record.companyName : (customData?.[columnKey] ?? null);
  }
  const recordField = GHL_KNOWN_RECORD_FIELDS[columnKey];
  if (recordField && record) return record[recordField];
  return customData?.[columnKey] ?? null;
}

/** Shapes a person record into a GHL contact-creation payload. Tags are
 * supplied by the caller rather than derived here,
 * since a single push can attach more than one tag to a contact. `customFields`
 * is likewise pre-built by the caller (via buildGhlCustomFields) — this
 * function just carries it through, defaulting to empty when the push has no
 * active field mapping (ticket #51). `standardFieldMapping` (ticket #109) is
 * optional — omitting it reproduces today's behavior exactly (every standard
 * field included, company name prefers brand_name falling back to
 * company_name). When supplied, "skip" on any field nulls it out, and
 * companyName: "company_name" sends the raw name even when brand_name is
 * present. */
export function buildGhlContactPayload(
  record: Pick<
    GhlPushRecord,
    "firstName" | "lastName" | "email" | "phone" | "companyName" | "brandName" | "city" | "country"
  >,
  tags: string[],
  customFields: { id: string; value: string }[] = [],
  standardFieldMapping?: GhlStandardFieldMapping
): GhlContactPayloadShape {
  const companyName =
    standardFieldMapping?.companyName === "skip"
      ? null
      : standardFieldMapping?.companyName === "company_name"
        ? record.companyName
        : record.brandName || record.companyName;

  return {
    firstName: standardFieldMapping?.firstName === "skip" ? null : record.firstName,
    lastName: standardFieldMapping?.lastName === "skip" ? null : record.lastName,
    email: standardFieldMapping?.email === "skip" ? null : record.email,
    phone: standardFieldMapping?.phone === "skip" ? null : record.phone,
    companyName,
    city: standardFieldMapping?.city === "skip" ? null : record.city,
    country: standardFieldMapping?.country === "skip" ? null : record.country,
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
