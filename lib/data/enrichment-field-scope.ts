import type { CompanyListFilters } from "@/lib/data/companies";
import type { PersonListFilters } from "@/lib/data/people";
import type { VirtualColumnFilter, VirtualFilterGroup, VirtualFilterSet } from "@/lib/data/virtual-columns";

/** Which page the cross-table field picker was opened from. Sent by the picker
 * as `?from=` so /api/enrichment-fields can tell the two pages' shared URL
 * params apart. */
export type EnrichmentFieldsOrigin = "companies" | "people";

export function parseEnrichmentFieldsOrigin(value: string | null): EnrichmentFieldsOrigin | undefined {
  return value === "companies" || value === "people" ? value : undefined;
}

/** Keeps only the conditions `keep` accepts, and only ever RELAXES the filter
 * set (the result matches a superset of what the original matched). Dropping
 * a condition from an AND group relaxes it, but dropping one from an OR group
 * would narrow it, so an OR group (or OR set) that loses any part becomes
 * "always true" and is removed whole. An empty group can't stand in for
 * "always true": the SQL fold treats an empty OR group as false. */
export function relaxVirtualFilters(
  set: VirtualFilterSet | undefined,
  keep: (condition: VirtualColumnFilter) => boolean
): VirtualFilterSet | undefined {
  if (!set) return undefined;
  const groups: VirtualFilterGroup[] = [];
  for (const group of set.groups) {
    const kept = group.conditions.filter(keep);
    const lostAny = kept.length < group.conditions.length;
    // AND group: drop what we can't carry over. OR group: any loss means the
    // original group matched rows we can't express, so the group goes.
    const alwaysTrue = kept.length === 0 || (group.combinator === "or" && lostAny);
    if (alwaysTrue) {
      // OR across groups: one always-true group makes the whole set true.
      if (set.combinator === "or") return undefined;
      continue;
    }
    groups.push({ ...group, conditions: kept });
  }
  return groups.length > 0 ? { ...set, groups } : undefined;
}

/** Narrows the shared page filters so each side's discovery only applies
 * filters that describe ITS entity. The People and Companies pages share URL
 * param names, so the same URL parsed by both parsers makes e.g.
 * `phoneType=mobile` also constrain companies, which have no phone_type, and
 * the sample comes back empty (no "Company fields" in the picker). An
 * unfiltered sample beats an empty one, so anything not clearly meaningful on
 * the other side is dropped.
 *
 * - from "people": company discovery keeps niche, industry, country, employee
 *   size and company-sourced virtual-filter conditions. Person-only filters
 *   (search, phone/email, ESP, push, job title, last activity, source) and
 *   person-sourced conditions are dropped. Person discovery keeps everything.
 * - from "companies": the mirror image — person discovery keeps the same
 *   company-describing dimensions (people carry their company's niche,
 *   industry, country and employee count) plus person-sourced conditions.
 *   Company discovery keeps everything.
 * - no origin: unchanged, the pre-`from` behavior.
 *
 * Virtual-filter conditions with no `source` mean the page's own entity, so
 * that fallback is resolved against the origin page before comparing. The
 * kept conditions always carry an explicit source (or the receiving RPC's own
 * default), so they read the same on either side without rewriting. */
export function narrowEnrichmentFilters(
  from: EnrichmentFieldsOrigin | undefined,
  companyFilters: CompanyListFilters,
  personFilters: PersonListFilters
): { companyFilters: CompanyListFilters; personFilters: PersonListFilters } {
  if (!from) return { companyFilters, personFilters };

  const ownEntity = from === "people" ? "person" : "company";
  const keepSource = (target: "company" | "person") => (c: VirtualColumnFilter) =>
    (c.source ?? ownEntity) === target;

  if (from === "people") {
    const { niche, industry, country, employeeBucket, employeeMin, employeeMax, virtualFilters } = companyFilters;
    return {
      companyFilters: {
        niche,
        industry,
        country,
        employeeBucket,
        employeeMin,
        employeeMax,
        virtualFilters: relaxVirtualFilters(virtualFilters, keepSource("company")),
      },
      personFilters,
    };
  }

  const { niche, industry, country, employeeBucket, employeeMin, employeeMax, virtualFilters } = personFilters;
  return {
    companyFilters,
    personFilters: {
      niche,
      industry,
      country,
      employeeBucket,
      employeeMin,
      employeeMax,
      virtualFilters: relaxVirtualFilters(virtualFilters, keepSource("person")),
    },
  };
}
