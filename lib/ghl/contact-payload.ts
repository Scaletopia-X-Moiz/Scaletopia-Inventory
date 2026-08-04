import type { GhlContactPayloadShape, GhlFieldMapping, GhlPushRecord } from "@/lib/ghl/types";

/** Shapes a person record into a GHL contact-creation payload. Tags are
 * supplied by the caller (built via buildGhlTag) rather than derived here,
 * since a single push can attach more than one tag to a contact. `customFields`
 * is likewise pre-built by the caller (via buildGhlCustomFields) — this
 * function just carries it through, defaulting to empty when the push has no
 * active field mapping (ticket #51). */
export function buildGhlContactPayload(
  record: Pick<
    GhlPushRecord,
    "firstName" | "lastName" | "email" | "phone" | "companyName" | "brandName" | "city" | "country"
  >,
  tags: string[],
  customFields: { id: string; value: string }[] = []
): GhlContactPayloadShape {
  return {
    firstName: record.firstName,
    lastName: record.lastName,
    email: record.email,
    phone: record.phone,
    // Prefer the cleaned company name (companies.brand_name); fall back to
    // the raw denormalized company_name for any company not yet cleaned.
    companyName: record.brandName || record.companyName,
    city: record.city,
    country: record.country,
    tags,
    customFields,
  };
}

/** Stringifies one custom_data value for GHL's text-only custom-field API.
 * List-type enrichment columns (lib/data/virtual-columns.ts) store a JSON
 * array — joined with ", " explicitly rather than relying on Array's
 * implicit toString (which is equivalent but easy to misread as a bug at the
 * call site) so a mapped list column reads as "a, b, c" rather than "a,b,c". */
function stringifyCustomFieldValue(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(", ") : String(value);
}

/** Resolves a mapping step's chosen virtual-column → GHL-field pairs
 * (ticket #51) against one candidate's raw custom_data, producing the
 * `{id, value}` entries GHL expects on `customFields`. A mapping is skipped
 * (not sent as an empty string) when its key is missing from custom_data,
 * or its value is null/undefined/empty — matching how the rest of the push
 * treats "no data" as "omit" rather than "send blank". Values are stringified
 * since GHL's custom-field API takes text regardless of the field's own
 * dataType. */
export function buildGhlCustomFields(
  customData: Record<string, unknown> | null,
  mapping: GhlFieldMapping[]
): { id: string; value: string }[] {
  if (!customData || mapping.length === 0) return [];

  const fields: { id: string; value: string }[] = [];
  for (const { virtualColumnKey, ghlFieldId } of mapping) {
    const value = customData[virtualColumnKey];
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    fields.push({ id: ghlFieldId, value: stringifyCustomFieldValue(value) });
  }
  return fields;
}
