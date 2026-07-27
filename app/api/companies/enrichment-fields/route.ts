import type { NextRequest } from "next/server";
import { getCompanyEnrichmentFields } from "@/lib/data/enrichment-fields";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";

/** Backs the "Add column from enrichment" field picker (ticket #34) —
 * discovery is scoped to the currently active filters (including any active
 * virtual filter), matching the ADR's "offered fields reflect the current
 * filtered set" decision. */
export async function GET(request: NextRequest) {
  const filters = parseCompanyFilters(request.nextUrl.searchParams);
  const result = await getCompanyEnrichmentFields(filters);
  return Response.json(result);
}
