import type { NextRequest } from "next/server";
import { getPersonEnrichmentFields } from "@/lib/data/enrichment-fields";
import { parsePersonFilters } from "@/lib/data/people-search-params";

/** Backs the "Add column from enrichment" field picker on /people (ticket
 * #41), mirroring app/api/companies/enrichment-fields/route.ts — discovery is
 * scoped to the currently active filters (including any active virtual
 * filter), matching the ADR's "offered fields reflect the current filtered
 * set" decision. */
export async function GET(request: NextRequest) {
  const filters = parsePersonFilters(request.nextUrl.searchParams);
  const result = await getPersonEnrichmentFields(filters);
  return Response.json(result);
}
