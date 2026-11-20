import { describe, expect, it, vi } from "vitest";
import { applyOpenTagsFilter, pgArrayLiteral } from "@/lib/data/open-tags";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { toFilterOptionsRpcPayload as companyPayload } from "@/lib/data/companies";
import { toFilterOptionsRpcPayload as personPayload } from "@/lib/data/people";

describe("pgArrayLiteral", () => {
  it("quotes plain and nasty tags", () => {
    expect(pgArrayLiteral(["a b", "x,y", 'say "hi"', "{br}", "back\\slash"])).toBe(
      '{"a b","x,y","say \\"hi\\"","{br}","back\\\\slash"}'
    );
  });
});

describe("applyOpenTagsFilter", () => {
  it("is a no-op without a filter", () => {
    const q = {};
    expect(applyOpenTagsFilter(q, undefined)).toBe(q);
  });
  it("applies overlap for include and not-overlap for exclude", () => {
    const q = { not: vi.fn(() => q), filter: vi.fn(() => q) };
    applyOpenTagsFilter(q, { include: ["a,b"], exclude: ["c"] });
    expect(q.not).toHaveBeenCalledWith("open_tags", "ov", '{"c"}');
    expect(q.filter).toHaveBeenCalledWith("open_tags", "ov", '{"a,b"}');
  });
});

describe("tags param", () => {
  const sp = new URLSearchParams("tags=one two&tags=three&tags_exclude=four");
  const expected = { include: ["one two", "three"], exclude: ["four"] };
  it("parses into openTags for companies and people", () => {
    expect(parseCompanyFilters(sp).openTags).toEqual(expected);
    expect(parsePersonFilters(sp).openTags).toEqual(expected);
  });
  it("is carried in both RPC payloads", () => {
    expect(companyPayload(parseCompanyFilters(sp)).openTags).toEqual(expected);
    expect(personPayload(parsePersonFilters(sp)).openTags).toEqual(expected);
    expect(companyPayload({}).openTags).toEqual({ include: [], exclude: [] });
    expect(personPayload({}).openTags).toEqual({ include: [], exclude: [] });
  });
});
