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
}
