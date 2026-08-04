import type {
  EmailBisonCustomVariableEntry,
  EmailBisonLeadPayload,
  EmailBisonPushRecord,
  EmailBisonStandardFieldMapping,
} from "@/lib/emailbison/types";

/** Maps a bindable "People-table column" name (as offered in the Add-to-
 * EmailBison row-adder, issue #52/#61) to the matching EmailBisonPushRecord
 * field — the standard-column half of a column-bound custom-variable entry.
 * A columnKey that isn't one of these falls through to custom_data (an
 * enrichment/virtual column) in resolveCustomVariables. */
const KNOWN_RECORD_FIELDS: Record<string, keyof EmailBisonPushRecord> = {
  firstName: "firstName",
  lastName: "lastName",
  email: "email",
  phone: "phone",
  companyName: "companyName",
  title: "title",
  website: "website",
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

/** Resolves each custom-variable entry against one candidate's data: a
 * literal entry (no `columnKey`) passes through untouched; a column-bound
 * entry reads the matching EmailBisonPushRecord field or, failing that, the
 * candidate's raw custom_data (a virtual/enrichment column) — issue #61's
 * "bound to a People-table column or virtual column" requirement. An entry
 * that resolves to null/undefined (missing enrichment data for this
 * particular record) is dropped rather than sent as an empty string, so one
 * record's missing field doesn't send a misleading blank value to EmailBison.
 * Called once per candidate, not once per push, since the resolved value
 * differs per record. */
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

    const recordField = KNOWN_RECORD_FIELDS[entry.columnKey];
    // companyName gets the same clean-name preference as buildEmailBisonLeadPayload,
    // so a custom variable bound to "Company name" isn't left sending the raw value.
    const raw =
      entry.columnKey === "companyName"
        ? record.brandName || record.companyName
        : recordField
          ? record[recordField]
          : (customData?.[entry.columnKey] ?? null);
    const value = stringifyCustomValue(raw);
    if (value === null) continue;
    resolved.push({ name: entry.name, value });
  }
  return resolved;
}

/** Applies an "include"/"skip" standard-field choice to a value — undefined
 * (mapping omitted, or that field absent from an older-shaped mapping)
 * behaves like "include", preserving today's always-include default. */
function applyIncludeSkip(value: string | null, choice: "include" | "skip" | undefined): string | null {
  return choice === "skip" ? null : value;
}

/** Resolves the companyName field per the mapping's 3-way choice:
 * "company_name" sends the raw denormalized name even when brand_name is
 * present, "skip" omits it, and "brand_name" (or an omitted mapping)
 * reproduces today's default — prefer the cleaned name, falling back to the
 * raw one for any company not yet cleaned. */
function resolveCompanyName(
  record: EmailBisonPushRecord,
  choice: EmailBisonStandardFieldMapping["companyName"] | undefined
): string | null {
  if (choice === "skip") return null;
  if (choice === "company_name") return record.companyName;
  return record.brandName || record.companyName;
}

/** Shapes a person record into an EmailBison lead upsert payload, mirroring
 * buildGhlContactPayload (lib/ghl/contact-payload.ts). Custom-variable
 * entries are supplied pre-resolved by the caller (literal value already
 * typed in, or a bound column already looked up via resolveCustomVariables)
 * — this function just carries them through onto `customVariables`,
 * defaulting to empty when the push has no entries selected.
 *
 * `standardFieldMapping` (issue #110) lets the caller override which
 * standard fields are sent — omitting it reproduces today's behavior
 * exactly: prefer brand_name for companyName, include every other field. */
export function buildEmailBisonLeadPayload(
  record: EmailBisonPushRecord,
  customVariables: EmailBisonCustomVariableEntry[] = [],
  existingLeadBehavior: "patch" | "put" = "patch",
  standardFieldMapping?: EmailBisonStandardFieldMapping
): EmailBisonLeadPayload {
  return {
    email: applyIncludeSkip(record.email, standardFieldMapping?.email),
    firstName: applyIncludeSkip(record.firstName, standardFieldMapping?.firstName),
    lastName: applyIncludeSkip(record.lastName, standardFieldMapping?.lastName),
    companyName: resolveCompanyName(record, standardFieldMapping?.companyName),
    title: applyIncludeSkip(record.title, standardFieldMapping?.title),
    phone: applyIncludeSkip(record.phone, standardFieldMapping?.phone),
    website: applyIncludeSkip(record.website, standardFieldMapping?.website),
    existingLeadBehavior,
    customVariables: customVariables.map(({ name, value }) => ({ name, value })),
  };
}
