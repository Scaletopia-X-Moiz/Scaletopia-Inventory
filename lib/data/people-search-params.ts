import type { PersonListFilters, SingleSelectFilter } from "@/lib/data/people";
import { parseIncludeExcludeParam } from "@/lib/data/include-exclude";
import { parseVirtualFiltersParam, parseVirtualColumnsParam } from "@/lib/data/virtual-columns";
import { parsePushStatusFilter } from "@/lib/data/push-status-filter";

function asSingleSelect(value: string | null): SingleSelectFilter | undefined {
  return value === "any" || value === "not_empty" || value === "empty" ? value : undefined;
}

/** Shared between the People page (server-rendered searchParams) and the
 * CSV export route (URL query string) so both read filters identically. */
export function parsePersonFilters(searchParams: URLSearchParams): PersonListFilters {
  const empMin = searchParams.get("empmin");
  const empMax = searchParams.get("empmax");
  return {
    search: searchParams.get("q") ?? undefined,
    niche: parseIncludeExcludeParam(searchParams, "niche"),
    source: parseIncludeExcludeParam(searchParams, "source"),
    country: parseIncludeExcludeParam(searchParams, "country"),
    employeeBucket: searchParams.getAll("employee"),
    industry: parseIncludeExcludeParam(searchParams, "industry"),
    email: asSingleSelect(searchParams.get("email")),
    phone: asSingleSelect(searchParams.get("phone")),
    emailStatus: parseIncludeExcludeParam(searchParams, "emailStatus"),
    phoneType: parseIncludeExcludeParam(searchParams, "phoneType"),
    jobTitle: searchParams.get("title") ?? undefined,
    employeeMin: Number.isFinite(Number(empMin)) && empMin ? Number(empMin) : undefined,
    employeeMax: Number.isFinite(Number(empMax)) && empMax ? Number(empMax) : undefined,
    pushStatus: parsePushStatusFilter(searchParams),
    virtualFilters: parseVirtualFiltersParam(searchParams),
    virtualColumns: parseVirtualColumnsParam(searchParams),
  };
}
