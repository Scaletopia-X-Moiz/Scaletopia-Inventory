import type { NextRequest } from "next/server";
import { getPersonFilterOptions } from "@/lib/data/people";
import { parsePersonFilters } from "@/lib/data/people-search-params";

export async function GET(request: NextRequest) {
  const filters = parsePersonFilters(request.nextUrl.searchParams);
  const options = await getPersonFilterOptions(filters);
  return Response.json(options);
}
