import type { NextRequest } from "next/server";
import { getAllEnrichmentFields } from "@/lib/data/enrichment-fields";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { narrowEnrichmentFilters, parseEnrichmentFieldsOrigin } from "@/lib/data/enrichment-field-scope";

/** Backs the cross-table "Add column from enrichment" field picker (issue
 * #30) — merges company and person enrichment fields into one source-tagged
 * list so either page's picker can offer both. Filters are parsed with the
 * same per-entity parsers as app/api/companies/enrichment-fields/route.ts and
 * app/api/people/enrichment-fields/route.ts, each reading only the query
 * params relevant to its own entity from the shared search params.
 *
 * `?from=people|companies` names the page the picker was opened from. The two
 * pages share param names, so without it the other entity gets this page's
 * person-only (or company-only) filters applied and can sample zero rows; with
 * it, narrowEnrichmentFilters keeps only the filters that describe each side.
 * No `from` keeps the unnarrowed behavior. */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const from = parseEnrichmentFieldsOrigin(searchParams.get("from"));
  const { companyFilters, personFilters } = narrowEnrichmentFilters(
    from,
    parseCompanyFilters(searchParams),
    parsePersonFilters(searchParams)
  );
  const result = await getAllEnrichmentFields(companyFilters, personFilters);
  return Response.json(result);
}
