import type { NextRequest } from "next/server";
import { getAllEnrichmentFields } from "@/lib/data/enrichment-fields";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";
import { parsePersonFilters } from "@/lib/data/people-search-params";

/** Backs the cross-table "Add column from enrichment" field picker (issue
 * #30) — merges company and person enrichment fields into one source-tagged
 * list so either page's picker can offer both. Filters are parsed with the
 * same per-entity parsers as app/api/companies/enrichment-fields/route.ts and
 * app/api/people/enrichment-fields/route.ts, each reading only the query
 * params relevant to its own entity from the shared search params. */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const companyFilters = parseCompanyFilters(searchParams);
  const personFilters = parsePersonFilters(searchParams);
  const result = await getAllEnrichmentFields(companyFilters, personFilters);
  return Response.json(result);
}
