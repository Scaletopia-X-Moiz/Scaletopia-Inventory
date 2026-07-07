import type { CompanyListFilters, SingleSelectFilter } from "@/lib/data/companies";

function asSingleSelect(value: string | null): SingleSelectFilter | undefined {
  return value === "any" || value === "not_empty" || value === "empty" ? value : undefined;
}

/** Shared between the Companies page (server-rendered searchParams) and the
 * CSV export route (URL query string) so both read filters identically. */
export function parseCompanyFilters(searchParams: URLSearchParams): CompanyListFilters {
  const empMin = searchParams.get("empmin");
  const empMax = searchParams.get("empmax");
  return {
    search: searchParams.get("q") ?? undefined,
    niche: searchParams.getAll("niche"),
    source: searchParams.getAll("source"),
    industry: searchParams.getAll("industry"),
    employeeBucket: searchParams.getAll("employee"),
    country: searchParams.getAll("country"),
    employeeMin: Number.isFinite(Number(empMin)) && empMin ? Number(empMin) : undefined,
    employeeMax: Number.isFinite(Number(empMax)) && empMax ? Number(empMax) : undefined,
    email: asSingleSelect(searchParams.get("email")),
    phone: asSingleSelect(searchParams.get("phone")),
    emailStatus: searchParams.getAll("emailStatus"),
    phoneType: searchParams.getAll("phoneType"),
  };
}

export function parsePage(searchParams: URLSearchParams): number {
  const page = Number(searchParams.get("page") ?? "1");
  return Number.isFinite(page) && page > 0 ? Math.floor(page) : 1;
}
