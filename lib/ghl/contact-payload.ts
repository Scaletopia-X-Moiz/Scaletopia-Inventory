import type { GhlContactPayload, GhlPushRecord } from "@/lib/ghl/types";

/** Shapes a person record into a GHL contact-creation payload. Tags are
 * supplied by the caller (built via buildGhlTag) rather than derived here,
 * since a single push can attach more than one tag to a contact. */
export function buildGhlContactPayload(
  record: Pick<
    GhlPushRecord,
    "firstName" | "lastName" | "email" | "phone" | "companyName" | "city" | "country"
  >,
  tags: string[]
): GhlContactPayload {
  return {
    firstName: record.firstName,
    lastName: record.lastName,
    email: record.email,
    phone: record.phone,
    companyName: record.companyName,
    city: record.city,
    country: record.country,
    tags,
  };
}
