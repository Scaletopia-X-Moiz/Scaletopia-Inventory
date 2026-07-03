import type { NextRequest } from "next/server";
import { getCompanyFilterOptions } from "@/lib/data/companies";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";

export async function GET(request: NextRequest) {
  const filters = parseCompanyFilters(request.nextUrl.searchParams);
  const options = await getCompanyFilterOptions(filters);
  return Response.json(options);
}
