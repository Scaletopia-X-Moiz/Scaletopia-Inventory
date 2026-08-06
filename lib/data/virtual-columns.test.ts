import { describe, expect, it } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  MULTI_SELECT_VALUE_CAP,
  filterSet,
  isLowCardinalityTextField,
  parseVirtualColumnsParam,
  parseVirtualFiltersParam,
  serializeVirtualColumnsParam,
  serializeVirtualFiltersParam,
  type ActiveVirtualColumn,
  type VirtualColumnFilter,
  type VirtualFilterSet,
} from "@/lib/data/virtual-columns";

/** Exercises the shared SQL predicate (lib/data/virtual-columns.sql) directly
 * with synthetic custom_data/filter payloads, independent of whatever real
 * enrichment data happens to be in the connected environment — this is the
 * "single place a virtual-column predicate is evaluated" ticket #33
 * introduces, so its correctness (especially the numeric/date ordering
 * ADR-0002 calls out) is tested at the function itself, not through
 * getCompanies/getPeople (no operator UI exists yet to drive those). */
async function matches(data: Record<string, unknown>, filter: VirtualColumnFilter): Promise<boolean> {
  const { data: result, error } = await supabaseAdmin.rpc("virtual_filter_predicate_matches", { data, f: filter });
  if (error) throw error;
  return result as boolean;
}

async function isEmpty(value: unknown): Promise<boolean> {
  const { data: result, error } = await supabaseAdmin.rpc("is_empty_enrichment_value", { v: value });
  if (error) throw error;
  return result as boolean;
}

describe("is_empty_enrichment_value", () => {
  it("treats null, missing, blank, sentinel, and unrendered templates as empty", async () => {
    expect(await isEmpty(null)).toBe(true);
    expect(await isEmpty("")).toBe(true);
    expect(await isEmpty("   ")).toBe(true);
    expect(await isEmpty("-")).toBe(true);
    expect(await isEmpty("{{ 0 }}")).toBe(true);
    expect(await isEmpty([])).toBe(true);
  });

  it("does not treat real data as empty", async () => {
    expect(await isEmpty("real value")).toBe(false);
    expect(await isEmpty("0")).toBe(false);
    expect(await isEmpty(["a3"])).toBe(false);
    expect(await isEmpty(0)).toBe(false);
  });
});

describe("virtual_filter_predicate_matches — number", () => {
  it("compares numerically, not lexicographically (9 < 90, not '9' > '90')", async () => {
    const filter: VirtualColumnFilter = { key: "lead_score", type: "number", operator: "gt", value: 50 };
    expect(await matches({ lead_score: "9" }, filter)).toBe(false);
    expect(await matches({ lead_score: "90" }, filter)).toBe(true);
    expect(await matches({ lead_score: 90 }, filter)).toBe(true);
  });

  it("excludes junk values instead of throwing", async () => {
    const filter: VirtualColumnFilter = { key: "spend", type: "number", operator: "between", value: [0, 100] };
    await expect(matches({ spend: "$10" }, filter)).resolves.toBe(false);
    await expect(matches({ spend: "-" }, filter)).resolves.toBe(false);
    await expect(matches({ spend: "{{ 0 }}" }, filter)).resolves.toBe(false);
    await expect(matches({ spend: "20%" }, filter)).resolves.toBe(false);
    await expect(matches({}, filter)).resolves.toBe(false);
    await expect(matches({ spend: 10 }, filter)).resolves.toBe(true);
  });
});

describe("virtual_filter_predicate_matches — date", () => {
  it("selects by chronological (not just string-alphabetical) order", async () => {
    const before: VirtualColumnFilter = { key: "indexed_at", type: "date", operator: "before", value: "2025-06-01" };
    expect(await matches({ indexed_at: "2025-05-05" }, before)).toBe(true);
    expect(await matches({ indexed_at: "2025-07-01" }, before)).toBe(false);
  });

  it("excludes malformed date junk instead of throwing", async () => {
    const on: VirtualColumnFilter = { key: "indexed_at", type: "date", operator: "on", value: "2025-05-05" };
    await expect(matches({ indexed_at: "not-a-date" }, on)).resolves.toBe(false);
    await expect(matches({ indexed_at: "-" }, on)).resolves.toBe(false);
  });
});

describe("virtual_filter_predicate_matches — boolean (ticket #36)", () => {
  it("is_true/is_false read a real JSON boolean", async () => {
    const isTrue: VirtualColumnFilter = { key: "is_active", type: "boolean", operator: "is_true" };
    const isFalse: VirtualColumnFilter = { key: "is_active", type: "boolean", operator: "is_false" };
    expect(await matches({ is_active: true }, isTrue)).toBe(true);
    expect(await matches({ is_active: false }, isTrue)).toBe(false);
    expect(await matches({ is_active: false }, isFalse)).toBe(true);
    expect(await matches({ is_active: true }, isFalse)).toBe(false);
  });

  it("is_true/is_false also read truthy/falsy string variants", async () => {
    const isTrue: VirtualColumnFilter = { key: "verified", type: "boolean", operator: "is_true" };
    const isFalse: VirtualColumnFilter = { key: "verified", type: "boolean", operator: "is_false" };
    expect(await matches({ verified: "true" }, isTrue)).toBe(true);
    expect(await matches({ verified: "yes" }, isTrue)).toBe(true);
    expect(await matches({ verified: "1" }, isTrue)).toBe(true);
    expect(await matches({ verified: "false" }, isFalse)).toBe(true);
    expect(await matches({ verified: "no" }, isFalse)).toBe(true);
    expect(await matches({ verified: "0" }, isFalse)).toBe(true);
  });

  it("excludes junk/missing values from both branches instead of throwing", async () => {
    const isTrue: VirtualColumnFilter = { key: "flag", type: "boolean", operator: "is_true" };
    const isFalse: VirtualColumnFilter = { key: "flag", type: "boolean", operator: "is_false" };
    expect(await matches({ flag: "-" }, isTrue)).toBe(false);
    expect(await matches({ flag: "-" }, isFalse)).toBe(false);
    expect(await matches({}, isTrue)).toBe(false);
    expect(await matches({}, isFalse)).toBe(false);
  });
});

describe("virtual_filter_predicate_matches — list", () => {
  it("matches an exact member, not a near-string (a3 does not match a30)", async () => {
    const contains: VirtualColumnFilter = { key: "specialties", type: "list", operator: "contains", value: "a3" };
    expect(await matches({ specialties: ["a3", "a4"] }, contains)).toBe(true);
    expect(await matches({ specialties: ["a30"] }, contains)).toBe(false);
  });

  it("not_contains is the exact inverse, member-exact (ticket #36)", async () => {
    const notContains: VirtualColumnFilter = {
      key: "specialties",
      type: "list",
      operator: "not_contains",
      value: "a3",
    };
    expect(await matches({ specialties: ["a3", "a4"] }, notContains)).toBe(false);
    expect(await matches({ specialties: ["a30"] }, notContains)).toBe(true);
  });

  it("is_empty/is_not_empty treat a zero-length array as empty (ticket #36)", async () => {
    const empty: VirtualColumnFilter = { key: "specialties", type: "list", operator: "is_empty" };
    const notEmpty: VirtualColumnFilter = { key: "specialties", type: "list", operator: "is_not_empty" };
    expect(await matches({ specialties: [] }, empty)).toBe(true);
    expect(await matches({ specialties: ["a3"] }, empty)).toBe(false);
    expect(await matches({ specialties: [] }, notEmpty)).toBe(false);
    expect(await matches({ specialties: ["a3"] }, notEmpty)).toBe(true);
  });

  it("does not match on a substring of a serialized array (member-exactness, not ILIKE)", async () => {
    const contains: VirtualColumnFilter = { key: "specialties", type: "list", operator: "contains", value: "a3" };
    // A non-array custom_data value must never match, even if its raw text
    // would substring-contain the target value.
    expect(await matches({ specialties: "a3, a30" }, contains)).toBe(false);
  });
});

describe("virtual_filter_predicate_matches — text contains/not_contains chip input (ticket #116)", () => {
  it("'contains' with a keyword array matches any of them", async () => {
    const filter: VirtualColumnFilter = {
      key: "niche",
      type: "text",
      operator: "contains",
      value: ["fintech", "insurtech"],
    };
    expect(await matches({ niche: "B2B Fintech SaaS" }, filter)).toBe(true);
    expect(await matches({ niche: "InsurTech platform" }, filter)).toBe(true);
    expect(await matches({ niche: "Healthtech" }, filter)).toBe(false);
    expect(await matches({}, filter)).toBe(false);
  });

  it("'not_contains' with a keyword array matches only when none of them appear", async () => {
    const filter: VirtualColumnFilter = {
      key: "niche",
      type: "text",
      operator: "not_contains",
      value: ["fintech", "insurtech"],
    };
    expect(await matches({ niche: "Healthtech" }, filter)).toBe(true);
    expect(await matches({ niche: "B2B Fintech SaaS" }, filter)).toBe(false);
    expect(await matches({}, filter)).toBe(true);
  });

  it("a single-element array behaves identically to the scalar form (no regression)", async () => {
    const scalar: VirtualColumnFilter = { key: "niche", type: "text", operator: "contains", value: "fintech" };
    const array: VirtualColumnFilter = { key: "niche", type: "text", operator: "contains", value: ["fintech"] };
    for (const data of [{ niche: "B2B Fintech SaaS" }, { niche: "Healthtech" }, {}]) {
      expect(await matches(data, array)).toBe(await matches(data, scalar));
    }
  });
});

describe("virtual_filter_predicate_matches — text contains on a string-valued (categories-style) field", () => {
  // `categories` is classified Text (its dominant value shape is a scalar
  // string like "/Food & Drink/Food/Snack Foods"), unlike `specialties` (List).
  // Filtering it with `contains` runs the text path (text_contains_matches);
  // this pins the semantics after that helper was rewritten to be inlinable
  // (SubLink pushed down into jsonb_ilike_patterns) to stop timing out (57014)
  // on the full-table scan. Every shape below must keep matching exactly as the
  // pre-rewrite EXISTS did.
  it("substring-matches a scalar keyword against a string value", async () => {
    const filter: VirtualColumnFilter = { key: "categories", type: "text", operator: "contains", value: "software" };
    expect(await matches({ categories: "Business Software & Services" }, filter)).toBe(true);
    expect(await matches({ categories: "/Food & Drink/Food/Snack Foods" }, filter)).toBe(false);
    expect(await matches({}, filter)).toBe(false);
  });

  it("a single-element keyword array behaves identically to the scalar form", async () => {
    const scalar: VirtualColumnFilter = { key: "categories", type: "text", operator: "contains", value: "food" };
    const array: VirtualColumnFilter = { key: "categories", type: "text", operator: "contains", value: ["food"] };
    for (const data of [{ categories: "/Food & Drink/Food/Snack Foods" }, { categories: "Software" }, {}]) {
      expect(await matches(data, array)).toBe(await matches(data, scalar));
    }
  });

  it("a multi-keyword array matches any of the keywords (case-insensitive)", async () => {
    const filter: VirtualColumnFilter = {
      key: "categories",
      type: "text",
      operator: "contains",
      value: ["software", "snack"],
    };
    expect(await matches({ categories: "Enterprise SOFTWARE" }, filter)).toBe(true);
    expect(await matches({ categories: "/Food & Drink/Food/Snack Foods" }, filter)).toBe(true);
    expect(await matches({ categories: "Automotive" }, filter)).toBe(false);
  });

  it("not_contains is the inverse and includes rows missing the key", async () => {
    const filter: VirtualColumnFilter = {
      key: "categories",
      type: "text",
      operator: "not_contains",
      value: ["software", "snack"],
    };
    expect(await matches({ categories: "Automotive" }, filter)).toBe(true);
    expect(await matches({ categories: "Enterprise Software" }, filter)).toBe(false);
    expect(await matches({}, filter)).toBe(true);
  });

  it("tolerates a mixed-shape row (an array value under a Text-typed key) without error", async () => {
    // Real custom_data holds the same key as different shapes across rows. When
    // a Text-typed key happens to carry an array, the text path reads it as its
    // serialized JSON text — it must never throw, just match on that text.
    const filter: VirtualColumnFilter = { key: "categories", type: "text", operator: "contains", value: "software" };
    await expect(matches({ categories: ["software", "retail"] }, filter)).resolves.toBe(true);
    await expect(matches({ categories: ["retail"] }, filter)).resolves.toBe(false);
  });
});

describe("virtual_filter_predicate_matches — list contains/not_contains chip input (ticket #116)", () => {
  it("'contains' with a keyword array matches any exact member (still member-exact, not substring)", async () => {
    const filter: VirtualColumnFilter = { key: "specialties", type: "list", operator: "contains", value: ["a3", "a4"] };
    expect(await matches({ specialties: ["a3"] }, filter)).toBe(true);
    expect(await matches({ specialties: ["a4", "a5"] }, filter)).toBe(true);
    expect(await matches({ specialties: ["a30"] }, filter)).toBe(false);
    expect(await matches({}, filter)).toBe(false);
  });

  it("'not_contains' with a keyword array matches only when none of them are members", async () => {
    const filter: VirtualColumnFilter = {
      key: "specialties",
      type: "list",
      operator: "not_contains",
      value: ["a3", "a4"],
    };
    expect(await matches({ specialties: ["a30"] }, filter)).toBe(true);
    expect(await matches({ specialties: ["a3"] }, filter)).toBe(false);
    expect(await matches({}, filter)).toBe(true);
  });

  it("a single-element array behaves identically to the scalar form (no regression)", async () => {
    const scalar: VirtualColumnFilter = { key: "specialties", type: "list", operator: "contains", value: "a3" };
    const array: VirtualColumnFilter = { key: "specialties", type: "list", operator: "contains", value: ["a3"] };
    for (const data of [{ specialties: ["a3", "a4"] }, { specialties: ["a30"] }, {}]) {
      expect(await matches(data, array)).toBe(await matches(data, scalar));
    }
  });
});

describe("virtual_filter_predicate_matches — empty/not-empty share the one normalization", () => {
  it("is_empty and is_not_empty partition every case exhaustively", async () => {
    const values = ["", "  ", "-", "{{ x }}", "real", null, [], ["x"]];
    for (const value of values) {
      const isEmptyOp = await matches({ k: value }, { key: "k", type: "text", operator: "is_empty" });
      const isNotEmptyOp = await matches({ k: value }, { key: "k", type: "text", operator: "is_not_empty" });
      expect(isEmptyOp).toBe(!isNotEmptyOp);
    }
  });
});

describe("virtual_filter_predicate_matches — text is/is_not value list (ticket #38)", () => {
  it("'is' with a scalar keeps exact-match semantics unchanged", async () => {
    const filter: VirtualColumnFilter = { key: "tier", type: "text", operator: "is", value: "gold" };
    expect(await matches({ tier: "gold" }, filter)).toBe(true);
    expect(await matches({ tier: "silver" }, filter)).toBe(false);
    expect(await matches({}, filter)).toBe(false);
  });

  it("'is' with a value list matches any listed value (multi-select 'is any of')", async () => {
    const filter: VirtualColumnFilter = { key: "tier", type: "text", operator: "is", value: ["gold", "silver"] };
    expect(await matches({ tier: "gold" }, filter)).toBe(true);
    expect(await matches({ tier: "silver" }, filter)).toBe(true);
    expect(await matches({ tier: "bronze" }, filter)).toBe(false);
    expect(await matches({}, filter)).toBe(false);
  });

  it("'is_not' with a value list excludes every listed value, keeps the rest (incl. missing)", async () => {
    const filter: VirtualColumnFilter = { key: "tier", type: "text", operator: "is_not", value: ["gold", "silver"] };
    expect(await matches({ tier: "gold" }, filter)).toBe(false);
    expect(await matches({ tier: "silver" }, filter)).toBe(false);
    expect(await matches({ tier: "bronze" }, filter)).toBe(true);
    expect(await matches({}, filter)).toBe(true);
  });
});

describe("isLowCardinalityTextField (ticket #38)", () => {
  it("is true only for a non-empty set at or below the cap", () => {
    expect(isLowCardinalityTextField([])).toBe(false);
    expect(isLowCardinalityTextField(["a"])).toBe(true);
    expect(isLowCardinalityTextField(Array.from({ length: MULTI_SELECT_VALUE_CAP }, (_, i) => `v${i}`))).toBe(true);
    expect(isLowCardinalityTextField(Array.from({ length: MULTI_SELECT_VALUE_CAP + 1 }, (_, i) => `v${i}`))).toBe(false);
  });
});

describe("value-list validation on the vf param (ticket #38)", () => {
  it("round-trips an is/is_not value list unchanged", () => {
    const filters: VirtualColumnFilter[] = [
      { key: "tier", type: "text", operator: "is", value: ["gold", "silver"] },
      { key: "stage", type: "text", operator: "is_not", value: ["lost"] },
    ];
    const params = new URLSearchParams();
    params.set("vf", serializeVirtualFiltersParam(filterSet(...filters))!);
    expect(parseVirtualFiltersParam(params)).toEqual(filterSet(...filters));
  });

  it("drops a value list that is empty or carries a blank/non-string entry", () => {
    const params = new URLSearchParams();
    params.set(
      "vf",
      JSON.stringify([
        { key: "a", type: "text", operator: "is", value: [] }, // empty list
        { key: "b", type: "text", operator: "is", value: ["", "x"] }, // blank entry
        { key: "c", type: "text", operator: "is", value: ["ok", 3] }, // non-string entry
        { key: "d", type: "text", operator: "contains", value: [] }, // empty array not allowed
        { key: "e", type: "text", operator: "is", value: ["real"] }, // valid — survives
      ])
    );
    expect(parseVirtualFiltersParam(params)).toEqual(filterSet(
      { key: "e", type: "text", operator: "is", value: ["real"] },
    ));
  });
});

describe("value-list validation on Text/List contains/not_contains (ticket #116)", () => {
  it("round-trips a chip-input keyword array unchanged, for both operators and types", () => {
    const filters: VirtualColumnFilter[] = [
      { key: "niche", type: "text", operator: "contains", value: ["fintech", "insurtech"] },
      { key: "niche", type: "text", operator: "not_contains", value: ["legacy"] },
      { key: "specialties", type: "list", operator: "contains", value: ["a3", "a4"] },
      { key: "specialties", type: "list", operator: "not_contains", value: ["a30"] },
    ];
    const params = new URLSearchParams();
    params.set("vf", serializeVirtualFiltersParam(filterSet(...filters))!);
    expect(parseVirtualFiltersParam(params)).toEqual(filterSet(...filters));
  });

  it("keeps the single-string form valid for contains/not_contains (no regression)", () => {
    const filters: VirtualColumnFilter[] = [
      { key: "niche", type: "text", operator: "contains", value: "fintech" },
      { key: "specialties", type: "list", operator: "contains", value: "a3" },
    ];
    const params = new URLSearchParams();
    params.set("vf", serializeVirtualFiltersParam(filterSet(...filters))!);
    expect(parseVirtualFiltersParam(params)).toEqual(filterSet(...filters));
  });

  it("drops a contains/not_contains array that is empty or carries a blank/non-string entry", () => {
    const params = new URLSearchParams();
    params.set(
      "vf",
      JSON.stringify([
        { key: "a", type: "text", operator: "contains", value: [] },
        { key: "b", type: "text", operator: "not_contains", value: ["", "x"] },
        { key: "c", type: "list", operator: "contains", value: ["ok", 3] },
        { key: "d", type: "text", operator: "contains", value: ["real"] }, // valid — survives
      ])
    );
    expect(parseVirtualFiltersParam(params)).toEqual(filterSet(
      { key: "d", type: "text", operator: "contains", value: ["real"] },
    ));
  });
});

describe("vf/vc URL param round-trip (ticket #34)", () => {
  it("serializes and re-parses a virtual filter set unchanged", () => {
    const filters: VirtualColumnFilter[] = [
      { key: "lead_score", type: "text", operator: "is", value: "gold" },
      { key: "tier", type: "text", operator: "is_empty" },
    ];
    const params = new URLSearchParams();
    params.set("vf", serializeVirtualFiltersParam(filterSet(...filters))!);
    expect(parseVirtualFiltersParam(params)).toEqual(filterSet(...filters));
  });

  it("serializes and re-parses an active-columns set unchanged", () => {
    const columns: ActiveVirtualColumn[] = [{ key: "lead_score", type: "text" }];
    const params = new URLSearchParams();
    params.set("vc", serializeVirtualColumnsParam(columns)!);
    expect(parseVirtualColumnsParam(params)).toEqual(columns);
  });

  it("returns undefined/empty for a missing param, without throwing", () => {
    const params = new URLSearchParams();
    expect(parseVirtualFiltersParam(params)).toBeUndefined();
    expect(parseVirtualColumnsParam(params)).toEqual([]);
  });

  it("drops a malformed vf param instead of throwing", () => {
    const params = new URLSearchParams();
    params.set("vf", "{not json");
    expect(parseVirtualFiltersParam(params)).toBeUndefined();
  });

  it("drops entries missing a required value or an unsupported type/operator", () => {
    const params = new URLSearchParams();
    params.set(
      "vf",
      JSON.stringify([
        { key: "a", type: "text", operator: "is" }, // missing required value
        { key: "b", type: "boolean", operator: "is_true" }, // valid, value-less (ticket #36)
        { key: "c", type: "text", operator: "bogus_op", value: "x" },
        { key: "d", type: "text", operator: "is", value: "ok" },
      ])
    );
    expect(parseVirtualFiltersParam(params)).toEqual(filterSet(
      { key: "b", type: "boolean", operator: "is_true" },
      { key: "d", type: "text", operator: "is", value: "ok" },
    ));
  });

  it("round-trips number and date filters, including between ranges (ticket #35)", () => {
    const filters: VirtualColumnFilter[] = [
      { key: "lead_score", type: "number", operator: "gt", value: 50 },
      { key: "spend", type: "number", operator: "between", value: [0, 100] },
      { key: "indexed_at", type: "date", operator: "before", value: "2025-06-01" },
      { key: "seen", type: "date", operator: "between", value: ["2025-01-01", "2025-12-31"] },
    ];
    const params = new URLSearchParams();
    params.set("vf", serializeVirtualFiltersParam(filterSet(...filters))!);
    expect(parseVirtualFiltersParam(params)).toEqual(filterSet(...filters));
  });

  it("drops number/date filters whose value has the wrong shape (ticket #35)", () => {
    const params = new URLSearchParams();
    params.set(
      "vf",
      JSON.stringify([
        { key: "a", type: "number", operator: "gt", value: "50" }, // string, not number
        { key: "b", type: "number", operator: "between", value: [5] }, // not a pair
        { key: "c", type: "date", operator: "on", value: "nope" }, // not an ISO date
        { key: "d", type: "date", operator: "between", value: ["2025-01-01", "x"] }, // half-valid pair
        { key: "e", type: "number", operator: "is", value: 7 }, // valid — survives
      ])
    );
    expect(parseVirtualFiltersParam(params)).toEqual(filterSet(
      { key: "e", type: "number", operator: "is", value: 7 },
    ));
  });

  it("accepts number and date active columns (ticket #35)", () => {
    const columns: ActiveVirtualColumn[] = [
      { key: "lead_score", type: "number" },
      { key: "indexed_at", type: "date" },
    ];
    const params = new URLSearchParams();
    params.set("vc", serializeVirtualColumnsParam(columns)!);
    expect(parseVirtualColumnsParam(params)).toEqual(columns);
  });

  it("round-trips boolean and list filters (ticket #36)", () => {
    const filters: VirtualColumnFilter[] = [
      { key: "is_active", type: "boolean", operator: "is_true" },
      { key: "verified", type: "boolean", operator: "is_false" },
      { key: "specialties", type: "list", operator: "contains", value: "a3" },
      { key: "specialties", type: "list", operator: "is_not_empty" },
    ];
    const params = new URLSearchParams();
    params.set("vf", serializeVirtualFiltersParam(filterSet(...filters))!);
    expect(parseVirtualFiltersParam(params)).toEqual(filterSet(...filters));
  });

  it("drops boolean/list filters with the wrong shape (ticket #36)", () => {
    const params = new URLSearchParams();
    params.set(
      "vf",
      JSON.stringify([
        { key: "a", type: "boolean", operator: "is_true", value: true }, // value-less op carrying a value is still parsed fine (value ignored)
        { key: "b", type: "boolean", operator: "gt", value: true }, // gt isn't a boolean operator
        { key: "c", type: "list", operator: "contains" }, // missing required value
        { key: "d", type: "list", operator: "contains", value: [] }, // empty array not allowed
        { key: "e", type: "list", operator: "is_empty" }, // valid — survives
      ])
    );
    expect(parseVirtualFiltersParam(params)).toEqual(filterSet(
      { key: "a", type: "boolean", operator: "is_true", value: true },
      { key: "e", type: "list", operator: "is_empty" },
    ));
  });

  it("accepts boolean and list active columns (ticket #36)", () => {
    const columns: ActiveVirtualColumn[] = [
      { key: "is_active", type: "boolean" },
      { key: "specialties", type: "list" },
    ];
    const params = new URLSearchParams();
    params.set("vc", serializeVirtualColumnsParam(columns)!);
    expect(parseVirtualColumnsParam(params)).toEqual(columns);
  });
});

describe("grouped vf param parse/serialize (ticket #117)", () => {
  it("parses a legacy flat array as one AND group (backward compatible)", () => {
    const params = new URLSearchParams();
    params.set(
      "vf",
      JSON.stringify([
        { key: "lead_score", type: "number", operator: "gt", value: 50 },
        { key: "tier", type: "text", operator: "is", value: "gold" },
      ])
    );
    expect(parseVirtualFiltersParam(params)).toEqual(
      filterSet(
        { key: "lead_score", type: "number", operator: "gt", value: 50 },
        { key: "tier", type: "text", operator: "is", value: "gold" }
      )
    );
  });

  it("round-trips a grouped (A OR B) AND (C) set through serialize/parse", () => {
    const set: VirtualFilterSet = {
      combinator: "and",
      groups: [
        {
          combinator: "or",
          conditions: [
            { key: "tier", type: "text", operator: "is", value: "gold" },
            { key: "tier", type: "text", operator: "is", value: "silver" },
          ],
        },
        {
          combinator: "and",
          conditions: [{ key: "lead_score", type: "number", operator: "gt", value: 50 }],
        },
      ],
    };
    const params = new URLSearchParams();
    params.set("vf", serializeVirtualFiltersParam(set)!);
    expect(parseVirtualFiltersParam(params)).toEqual(set);
  });

  it("serializes a single AND group back to the legacy flat array (short URL)", () => {
    const set = filterSet({ key: "tier", type: "text", operator: "is", value: "gold" });
    expect(serializeVirtualFiltersParam(set)).toBe(
      JSON.stringify([{ key: "tier", type: "text", operator: "is", value: "gold" }])
    );
  });

  it("drops malformed conditions and empty groups rather than throwing", () => {
    const params = new URLSearchParams();
    params.set(
      "vf",
      JSON.stringify({
        combinator: "or",
        groups: [
          { combinator: "and", conditions: [{ key: "a", type: "text", operator: "bogus", value: "x" }] }, // whole group empties out
          {
            combinator: "or",
            conditions: [
              { key: "b", type: "text", operator: "is", value: "" }, // dropped
              { key: "c", type: "text", operator: "is", value: "ok" }, // survives
            ],
          },
        ],
      })
    );
    expect(parseVirtualFiltersParam(params)).toEqual({
      combinator: "or",
      groups: [{ combinator: "or", conditions: [{ key: "c", type: "text", operator: "is", value: "ok" }] }],
    });
  });

  it("returns undefined for a set whose groups are all empty (no virtual filter)", () => {
    const params = new URLSearchParams();
    params.set("vf", JSON.stringify({ combinator: "and", groups: [{ combinator: "and", conditions: [] }] }));
    expect(parseVirtualFiltersParam(params)).toBeUndefined();
  });

  it("defaults a missing/invalid combinator to 'and'", () => {
    const params = new URLSearchParams();
    params.set(
      "vf",
      JSON.stringify({ groups: [{ conditions: [{ key: "c", type: "text", operator: "is", value: "ok" }] }] })
    );
    expect(parseVirtualFiltersParam(params)).toEqual(
      filterSet({ key: "c", type: "text", operator: "is", value: "ok" })
    );
  });
});

/** Drives the grouped fold (lib/data/virtual-columns.sql) directly with a
 * synthetic row + grouped set, independent of any real data — the ticket #117
 * counterpart to the per-predicate `matches()` suite above. */
async function setMatches(data: Record<string, unknown>, set: VirtualFilterSet): Promise<boolean> {
  const { data: result, error } = await supabaseAdmin.rpc("virtual_filters_match", { data, filters: set });
  if (error) throw error;
  return result as boolean;
}

const HIGH_SCORE: VirtualColumnFilter = { key: "lead_score", type: "number", operator: "gt", value: 50 };
const IS_GOLD: VirtualColumnFilter = { key: "tier", type: "text", operator: "is", value: "gold" };
const IS_SILVER: VirtualColumnFilter = { key: "tier", type: "text", operator: "is", value: "silver" };

describe("virtual_filters_match — grouped AND/OR fold (ticket #117)", () => {
  it("matches every row for an empty set (no active virtual filter)", async () => {
    expect(await setMatches({ anything: "goes" }, { combinator: "and", groups: [] })).toBe(true);
  });

  it("a single AND group reproduces the pre-#117 flat-AND behavior", async () => {
    const set = filterSet(HIGH_SCORE, IS_GOLD);
    expect(await setMatches({ lead_score: 90, tier: "gold" }, set)).toBe(true);
    expect(await setMatches({ lead_score: 90, tier: "silver" }, set)).toBe(false);
    expect(await setMatches({ lead_score: 10, tier: "gold" }, set)).toBe(false);
  });

  it("an OR group matches a row satisfying either condition", async () => {
    const set: VirtualFilterSet = {
      combinator: "and",
      groups: [{ combinator: "or", conditions: [IS_GOLD, IS_SILVER] }],
    };
    expect(await setMatches({ tier: "gold" }, set)).toBe(true);
    expect(await setMatches({ tier: "silver" }, set)).toBe(true);
    expect(await setMatches({ tier: "bronze" }, set)).toBe(false);
  });

  it("(A OR B) AND C matches only the intersection", async () => {
    // (tier is gold OR silver) AND lead_score > 50
    const set: VirtualFilterSet = {
      combinator: "and",
      groups: [
        { combinator: "or", conditions: [IS_GOLD, IS_SILVER] },
        { combinator: "and", conditions: [HIGH_SCORE] },
      ],
    };
    expect(await setMatches({ tier: "gold", lead_score: 90 }, set)).toBe(true);
    expect(await setMatches({ tier: "silver", lead_score: 90 }, set)).toBe(true);
    expect(await setMatches({ tier: "gold", lead_score: 10 }, set)).toBe(false); // fails C
    expect(await setMatches({ tier: "bronze", lead_score: 90 }, set)).toBe(false); // fails (A OR B)
  });

  it("a top-level OR across groups matches a row satisfying either group", async () => {
    // (lead_score > 50) OR (tier is gold)
    const set: VirtualFilterSet = {
      combinator: "or",
      groups: [
        { combinator: "and", conditions: [HIGH_SCORE] },
        { combinator: "and", conditions: [IS_GOLD] },
      ],
    };
    expect(await setMatches({ lead_score: 90, tier: "bronze" }, set)).toBe(true); // first group
    expect(await setMatches({ lead_score: 10, tier: "gold" }, set)).toBe(true); // second group
    expect(await setMatches({ lead_score: 10, tier: "bronze" }, set)).toBe(false); // neither
  });
});
