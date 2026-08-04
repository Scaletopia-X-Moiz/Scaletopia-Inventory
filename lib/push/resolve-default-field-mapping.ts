import type { ActiveVirtualColumn } from "@/lib/data/virtual-columns";
import type { GhlCustomField } from "@/lib/ghl/custom-fields";
import type { GhlFieldMapping, GhlStandardFieldMapping } from "@/lib/ghl/types";
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
    return {
      platform: "emailbison",
      standardFields: {
        companyName,
        firstName: "include",
        lastName: "include",
        email: "include",
        phone: "include",
        title: "include",
        website: "include",
      },
    };
  }

  // GHL custom fields default to the best fuzzy-name match against the
  // active virtual columns (candidates = virtual column keys, since
  // ActiveVirtualColumn has no separate display label). Below
  // fuzzyMatchColumn's own 0.4 threshold it returns null, which we carry
  // through as "no entry" — the preview screen renders that as "No data".
  const candidateKeys = args.virtualColumns.map((column) => column.key);
  const customFieldMapping: GhlFieldMapping[] = [];
  for (const field of args.customFields) {
    const match = fuzzyMatchColumn(field.name, candidateKeys);
    if (match) {
      customFieldMapping.push({ virtualColumnKey: match.field, ghlFieldId: field.id });
    }
  }

  return {
    platform: "ghl",
    standardFields: {
      companyName,
      firstName: "include",
      lastName: "include",
      email: "include",
      phone: "include",
      city: "include",
      country: "include",
    },
    customFieldMapping,
  };
}
