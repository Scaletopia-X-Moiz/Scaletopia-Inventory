import { supabaseAdmin } from "@/lib/supabase/admin";
import { toFilterOptionsRpcPayload as toCompanyFilterOptionsRpcPayload } from "@/lib/data/companies";
import { toFilterOptionsRpcPayload as toPersonFilterOptionsRpcPayload } from "@/lib/data/people";
import type { CompanyListFilters } from "@/lib/data/companies";
import type { PersonListFilters } from "@/lib/data/people";

export type EnrichmentFieldType = "Text" | "Number" | "Boolean" | "List" | "Date";

export interface EnrichmentField {
  key: string;
  type: EnrichmentFieldType;
  sampleValues: string[];
  source: "company" | "person";
}

export interface EnrichmentFieldDiscovery {
  fields: EnrichmentField[];
  /** Rows actually sampled — always <= the requested sample size, even on
   * the unfiltered table, since discovery never scans the full result set. */
  sampledRows: number;
}

interface EnrichmentFieldDiscoveryRpcResult {
  fields: Array<Omit<EnrichmentField, "source">>;
  sampledRows: number;
}

const DEFAULT_SAMPLE_SIZE = 500;
const DEFAULT_MAX_VALUES_PER_KEY = 25;

/** Discovers enrichment (custom_data) fields present in a bounded sample of
 * the companies currently matching `filters`, each with an inferred
 * filterable type and a capped list of distinct sample values. Backs the
 * "Add column from enrichment" field picker (docs/adr/0002-virtual-column-
 * enrichment-filtering.md, issue #32) — samples rather than scanning
 * `DISTINCT jsonb_object_keys` over the whole table so the picker opens fast
 * even with no filters active. */
export async function getCompanyEnrichmentFields(
  filters: CompanyListFilters = {},
  sampleSize: number = DEFAULT_SAMPLE_SIZE,
  maxValuesPerKey: number = DEFAULT_MAX_VALUES_PER_KEY
): Promise<EnrichmentFieldDiscovery> {
  const { data, error } = await supabaseAdmin.rpc("company_enrichment_fields", {
    filters: toCompanyFilterOptionsRpcPayload(filters),
    sample_size: sampleSize,
    max_values_per_key: maxValuesPerKey,
  });
  if (error) throw error;
  const result = data as EnrichmentFieldDiscoveryRpcResult;
  return {
    fields: result.fields.map((field) => ({ ...field, source: "company" as const })),
    sampledRows: result.sampledRows,
  };
}

/** Same as getCompanyEnrichmentFields, scoped to /people instead. */
export async function getPersonEnrichmentFields(
  filters: PersonListFilters = {},
  sampleSize: number = DEFAULT_SAMPLE_SIZE,
  maxValuesPerKey: number = DEFAULT_MAX_VALUES_PER_KEY
): Promise<EnrichmentFieldDiscovery> {
  const { data, error } = await supabaseAdmin.rpc("person_enrichment_fields", {
    filters: toPersonFilterOptionsRpcPayload(filters),
    sample_size: sampleSize,
    max_values_per_key: maxValuesPerKey,
  });
  if (error) throw error;
  const result = data as EnrichmentFieldDiscoveryRpcResult;
  return {
    fields: result.fields.map((field) => ({ ...field, source: "person" as const })),
    sampledRows: result.sampledRows,
  };
}

/** Merges company and person enrichment fields into one source-tagged list
 * for the cross-table field picker (issue #30) — offers both /companies and
 * /people custom_data keys regardless of which page the picker is opened
 * from. Runs both discovery RPCs in parallel; results are concatenated
 * (company fields first, then person fields) without deduping across
 * sources, since a key present on both tables is a distinct filterable field
 * per source. `sampledRows` reports the per-source counts rather than a
 * single combined number, since the two tables are sampled independently and
 * a sum would misleadingly imply one shared sample. */
export async function getAllEnrichmentFields(
  companyFilters: CompanyListFilters = {},
  personFilters: PersonListFilters = {},
  sampleSize: number = DEFAULT_SAMPLE_SIZE,
  maxValuesPerKey: number = DEFAULT_MAX_VALUES_PER_KEY
): Promise<{
  fields: EnrichmentField[];
  sampledRows: { company: number; person: number };
}> {
  const [companyResult, personResult] = await Promise.all([
    getCompanyEnrichmentFields(companyFilters, sampleSize, maxValuesPerKey),
    getPersonEnrichmentFields(personFilters, sampleSize, maxValuesPerKey),
  ]);
  return {
    fields: [...companyResult.fields, ...personResult.fields],
    sampledRows: { company: companyResult.sampledRows, person: personResult.sampledRows },
  };
}
