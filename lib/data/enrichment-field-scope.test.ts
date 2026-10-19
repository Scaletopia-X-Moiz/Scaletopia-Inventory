import { describe, expect, it } from "vitest";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import {
  narrowEnrichmentFilters,
  parseEnrichmentFieldsOrigin,
  relaxVirtualFilters,
} from "@/lib/data/enrichment-field-scope";
import type { VirtualColumnFilter, VirtualFilterSet } from "@/lib/data/virtual-columns";

function cond(key: string, source?: "company" | "person"): VirtualColumnFilter {
  return { key, type: "text", operator: "is", value: "x", ...(source ? { source } : {}) };
}

function parse(query: string) {
  const sp = new URLSearchParams(query);
  return { company: parseCompanyFilters(sp), person: parsePersonFilters(sp) };
}

const vf = (conditions: VirtualColumnFilter[]) =>
  encodeURIComponent(JSON.stringify({ combinator: "and", groups: [{ combinator: "and", conditions }] }));

describe("parseEnrichmentFieldsOrigin", () => {
  it("accepts only the two page names", () => {
    expect(parseEnrichmentFieldsOrigin("people")).toBe("people");
    expect(parseEnrichmentFieldsOrigin("companies")).toBe("companies");
    expect(parseEnrichmentFieldsOrigin("other")).toBeUndefined();
    expect(parseEnrichmentFieldsOrigin(null)).toBeUndefined();
  });
});

describe("narrowEnrichmentFilters", () => {
  const query =
    "niche=Therapy+%26+Counselling&country=US&industry=health&employee=11-50&source=apollo" +
    "&phoneType=mobile&emailStatus=valid&email=not_empty&phone=not_empty&q=smith&title=ceo";

  it("is a no-op without an origin", () => {
    const { company, person } = parse(query);
    const out = narrowEnrichmentFilters(undefined, company, person);
    expect(out.companyFilters).toBe(company);
    expect(out.personFilters).toBe(person);
  });

  it("from people: company side keeps only company-describing filters", () => {
    const { company, person } = parse(query);
    const out = narrowEnrichmentFilters("people", company, person);
    expect(out.personFilters).toBe(person);
    expect(out.companyFilters.niche).toEqual(company.niche);
    expect(out.companyFilters.country).toEqual(company.country);
    expect(out.companyFilters.industry).toEqual(company.industry);
    expect(out.companyFilters.employeeBucket).toEqual(["11-50"]);
    expect(out.companyFilters.phoneType).toBeUndefined();
    expect(out.companyFilters.emailStatus).toBeUndefined();
    expect(out.companyFilters.email).toBeUndefined();
    expect(out.companyFilters.phone).toBeUndefined();
    expect(out.companyFilters.search).toBeUndefined();
    expect(out.companyFilters.source).toBeUndefined();
  });

  it("from people: also drops ESP, push and push-job filters on the company side", () => {
    const { company, person } = parse(
      "niche=a&mxProvider=google&pushJobId=abc&pushJobOutcome=failed&pushClient=11111111-1111-1111-1111-111111111111&pushPlatform=ghl&pushStatus=pushed"
    );
    const out = narrowEnrichmentFilters("people", company, person);
    expect(out.companyFilters.mxProvider).toBeUndefined();
    expect(out.companyFilters.pushJobId).toBeUndefined();
    expect(out.companyFilters.pushJobOutcome).toBeUndefined();
    expect(out.companyFilters.pushStatus).toBeUndefined();
    expect(out.companyFilters.niche).toEqual(company.niche);
  });

  it("from people: keeps company-sourced vf conditions, drops person ones and bare ones (bare = person on /people)", () => {
    const { company, person } = parse(
      `vf=${vf([cond("a", "company"), cond("b", "person"), cond("c")])}`
    );
    const out = narrowEnrichmentFilters("people", company, person);
    expect(out.companyFilters.virtualFilters?.groups[0].conditions.map((c) => c.key)).toEqual(["a"]);
    expect(out.personFilters.virtualFilters?.groups[0].conditions).toHaveLength(3);
  });

  it("from companies: person side keeps company-describing filters, drops company-only ones", () => {
    const { company, person } = parse(query);
    const out = narrowEnrichmentFilters("companies", company, person);
    expect(out.companyFilters).toBe(company);
    expect(out.personFilters.niche).toEqual(person.niche);
    expect(out.personFilters.country).toEqual(person.country);
    expect(out.personFilters.industry).toEqual(person.industry);
    expect(out.personFilters.employeeBucket).toEqual(["11-50"]);
    expect(out.personFilters.phoneType).toBeUndefined();
    expect(out.personFilters.emailStatus).toBeUndefined();
    expect(out.personFilters.email).toBeUndefined();
    expect(out.personFilters.search).toBeUndefined();
    expect(out.personFilters.source).toBeUndefined();
    expect(out.personFilters.jobTitle).toBeUndefined();
  });

  it("from companies: keeps person-sourced vf conditions, drops company ones and bare ones (bare = company on /companies)", () => {
    const { company, person } = parse(
      `vf=${vf([cond("a", "person"), cond("b", "company"), cond("c")])}`
    );
    const out = narrowEnrichmentFilters("companies", company, person);
    expect(out.personFilters.virtualFilters?.groups[0].conditions.map((c) => c.key)).toEqual(["a"]);
    expect(out.companyFilters.virtualFilters?.groups[0].conditions).toHaveLength(3);
  });

  it("drops the vf set entirely when no condition survives", () => {
    const { company, person } = parse(`vf=${vf([cond("a", "person")])}`);
    const out = narrowEnrichmentFilters("people", company, person);
    expect(out.companyFilters.virtualFilters).toBeUndefined();
  });
});

describe("relaxVirtualFilters", () => {
  const keepCompany = (c: VirtualColumnFilter) => c.source === "company";

  it("returns undefined for undefined", () => {
    expect(relaxVirtualFilters(undefined, keepCompany)).toBeUndefined();
  });

  it("an AND group just loses the conditions it can't carry", () => {
    const set: VirtualFilterSet = {
      combinator: "and",
      groups: [{ combinator: "and", conditions: [cond("a", "company"), cond("b", "person")] }],
    };
    expect(relaxVirtualFilters(set, keepCompany)?.groups[0].conditions.map((c) => c.key)).toEqual(["a"]);
  });

  it("an OR group that loses a condition is dropped whole (dropping would narrow it)", () => {
    const set: VirtualFilterSet = {
      combinator: "and",
      groups: [
        { combinator: "or", conditions: [cond("a", "company"), cond("b", "person")] },
        { combinator: "and", conditions: [cond("c", "company")] },
      ],
    };
    const out = relaxVirtualFilters(set, keepCompany);
    expect(out?.groups).toHaveLength(1);
    expect(out?.groups[0].conditions.map((c) => c.key)).toEqual(["c"]);
  });

  it("an OR group that loses nothing is kept", () => {
    const set: VirtualFilterSet = {
      combinator: "and",
      groups: [{ combinator: "or", conditions: [cond("a", "company"), cond("b", "company")] }],
    };
    expect(relaxVirtualFilters(set, keepCompany)).toEqual(set);
  });

  it("an OR set with an always-true group is dropped whole", () => {
    const set: VirtualFilterSet = {
      combinator: "or",
      groups: [
        { combinator: "and", conditions: [cond("a", "company")] },
        { combinator: "and", conditions: [cond("b", "person")] },
      ],
    };
    expect(relaxVirtualFilters(set, keepCompany)).toBeUndefined();
  });
});
