/** Combined person+company fields needed to push a contact to GHL. Mirrors
 * the columns already denormalized onto a people row (employee_count,
 * niche, country, source) so the push orchestrator (ticket 47) can select
 * them directly without joining to companies. */
export interface GhlPushRecord {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  /** The linked company's cleaned name (companies.brand_name), joined in
   * alongside the raw companyName above so the push payload can prefer it.
   * null when the company has no linked row or hasn't been cleaned yet, in
   * which case the raw companyName is used instead. */
  brandName: string | null;
  city: string | null;
  country: string | null;
  niche: string | null;
  employeeCount: number | null;
  source: string | null;
}

/** Shape produced by buildGhlContactPayload — distinct from lib/ghl/client.ts's
 * own GhlContactPayload (the wire-level shape with optional, non-null fields
 * sent straight to GHL's API). This one uses `| null` for missing fields,
 * matching this repo's Detail/Row conventions; the push orchestrator
 * (ticket 47) is expected to convert between the two. */
export interface GhlContactPayloadShape {
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  companyName: string | null;
  city: string | null;
  country: string | null;
  tags: string[];
  /** GHL custom-field values built from the field-mapping step (ticket #51) —
   * one entry per mapped virtual column that had a non-empty value on this
   * candidate. Empty when no virtual columns are active or none are mapped.
   * Sent to GHL on the wire as `customFields` (plural, see lib/ghl/client.ts). */
  customFields: { id: string; value: string }[];
}

/** One user-chosen mapping from an active virtual column (People table
 * enrichment column) to a GHL custom field, collected by the push button's
 * mapping step (ticket #51) and sent to the push route alongside `clientId`. */
export interface GhlFieldMapping {
  /** The custom_data key the virtual column reads (ActiveVirtualColumn.key). */
  virtualColumnKey: string;
  /** The target GHL custom field's id (GhlCustomField.id from ticket #49). */
  ghlFieldId: string;
}
