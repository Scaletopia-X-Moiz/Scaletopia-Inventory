import type {
  EmailBisonCustomVariableEntry,
  EmailBisonLeadPayload,
  EmailBisonPushRecord,
} from "@/lib/emailbison/types";

/** Shapes a person record into an EmailBison lead upsert payload, mirroring
 * buildGhlContactPayload (lib/ghl/contact-payload.ts). Custom-variable
 * entries are supplied pre-resolved by the caller (literal value already
 * typed in, or a bound column already looked up) — this function just
 * carries them through onto `customVariables`, defaulting to empty when the
 * push has no entries selected. */
export function buildEmailBisonLeadPayload(
  record: EmailBisonPushRecord,
  customVariables: EmailBisonCustomVariableEntry[] = [],
  existingLeadBehavior: "patch" | "put" = "patch"
): EmailBisonLeadPayload {
  return {
    email: record.email,
    firstName: record.firstName,
    lastName: record.lastName,
    companyName: record.companyName,
    title: record.title,
    phone: record.phone,
    website: record.website,
    existingLeadBehavior,
    customVariables: customVariables.map(({ name, value }) => ({ name, value })),
  };
}
