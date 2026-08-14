import type { ActiveVirtualColumn } from "@/lib/data/virtual-columns";
import type { GhlCustomField } from "@/lib/ghl/custom-fields";
import type { GhlFieldMapping, GhlStandardFieldMapping } from "@/lib/ghl/types";
import { GHL_KNOWN_RECORD_FIELDS } from "@/lib/ghl/contact-payload";
import type { EmailBisonStandardFieldMapping } from "@/lib/emailbison/types";
import { fuzzyMatchColumn } from "@/lib/import/normalize";

/** The subset of a pushed record resolveDefaultFieldMapping needs to decide
 * the company-name default — satisfied structurally by both GhlPushRecord
 * and EmailBisonPushRecord without importing either. */
export interface PushRecordCompanyNameFields {
  companyName: string | null;
  brandName: string | null;
}

export interface ResolveDefaultGhlFieldMappingArgs {
  platform: "ghl";
  records: PushRecordCompanyNameFields[];
  virtualColumns: ActiveVirtualColumn[];
  customFields: GhlCustomField[];
}

export interface ResolveDefaultEmailBisonFieldMappingArgs {
  platform: "emailbison";
  records: PushRecordCompanyNameFields[];
}

export interface ResolveDefaultGhlFieldMappingResult {
  platform: "ghl";
  standardFields: GhlStandardFieldMapping;
  customFieldMapping: GhlFieldMapping[];
  /** fuzzyMatchColumn's match score (0-1) per mapped ghlFieldId — lets the
   * mapping table (ticket #142) render an import-style confidence dot.
   * Absent entries (no match above fuzzyMatchColumn's 0.4 threshold) render
   * as "no match". */
  customFieldScores: Record<string, number>;
}

export interface ResolveDefaultEmailBisonFieldMappingResult {
  platform: "emailbison";
  standardFields: EmailBisonStandardFieldMapping;
}

/** companies.brand_name coverage is ~0.2% of companies as of 2026-08-04, so
 * the default must favor the overwhelmingly common case (no brand_name in
 * the pushed set) cleanly rather than assume brand_name is usually present.
 * Set-wide (any record) rather than per-record, since this picks the single
 * default *source* the whole push's company-name row starts on — per-record
 * fallback already happens downstream in buildGhlContactPayload /
 * buildEmailBisonLeadPayload when the mapping resolves to "brand_name". */
function resolveDefaultCompanyNameSource(
  records: PushRecordCompanyNameFields[]
): "brand_name" | "company_name" {
  return records.some((record) => !!record.brandName) ? "brand_name" : "company_name";
}

/** Computes the default field mapping a push's preview screen (ticket #107)
 * pre-populates with — no I/O, mirroring the role autoMapColumns/
 * fuzzyMatchColumn play in the Import flow (lib/import/normalize.ts). The
 * result is fully overridable downstream; this only picks the starting
 * point. */
export function resolveDefaultFieldMapping(
  args: ResolveDefaultGhlFieldMappingArgs
): ResolveDefaultGhlFieldMappingResult;
export function resolveDefaultFieldMapping(
  args: ResolveDefaultEmailBisonFieldMappingArgs
): ResolveDefaultEmailBisonFieldMappingResult;
export function resolveDefaultFieldMapping(
  args: ResolveDefaultGhlFieldMappingArgs | ResolveDefaultEmailBisonFieldMappingArgs
): ResolveDefaultGhlFieldMappingResult | ResolveDefaultEmailBisonFieldMappingResult {
  const companyName = resolveDefaultCompanyNameSource(args.records);

  if (args.platform === "emailbison") {
    // Free-source mapping (rework of issue #110/#108): each field defaults to
    // its own record column, i.e. its own key — companyName is the one
    // exception, defaulting to the cleaned "brandName" column when any record
    // in the pushed set has one, else the raw "companyName" column, per
    // resolveDefaultCompanyNameSource above.
    return {
      platform: "emailbison",
      standardFields: {
        companyName: companyName === "brand_name" ? "brandName" : "companyName",
        firstName: "firstName",
        lastName: "lastName",
        email: "email",
        title: "title",
      },
    };
  }

  // GHL custom fields default to the best fuzzy-name match against the
  // active virtual columns plus the standard GHL record field names
  // (ticket #142 — previously only virtual columns were candidates, so a
  // custom field like "First Name" could never auto-map to the person's own
  // firstName). Below fuzzyMatchColumn's own 0.4 threshold it returns null,
  // which we carry through as "no entry" — the mapping table renders that as
  // "— ignore —". Deduped so a virtual column that happens to share a name
  // with a standard field isn't offered twice.
  const candidateKeys = [
    ...new Set([...args.virtualColumns.map((column) => column.key), ...Object.keys(GHL_KNOWN_RECORD_FIELDS)]),
  ];
  const customFieldMapping: GhlFieldMapping[] = [];
  const customFieldScores: Record<string, number> = {};
  for (const field of args.customFields) {
    const match = fuzzyMatchColumn(field.name, candidateKeys);
    if (match) {
      customFieldMapping.push({ ghlFieldId: field.id, source: "column", columnKey: match.field });
      customFieldScores[field.id] = match.score;
    }
  }

  // Free-source mapping (rework mirroring EmailBison's issue #110/#108
  // rework): each field defaults to its own record column, i.e. its own key
  // — companyName is the one exception, defaulting to the cleaned
  // "brandName" column when any record in the pushed set has one, else the
  // raw "companyName" column, per resolveDefaultCompanyNameSource above.
  return {
    platform: "ghl",
    standardFields: {
      companyName: companyName === "brand_name" ? "brandName" : "companyName",
      firstName: "firstName",
      lastName: "lastName",
      email: "email",
      phone: "phone",
      city: "city",
      country: "country",
    },
    customFieldMapping,
    customFieldScores,
  };
}
