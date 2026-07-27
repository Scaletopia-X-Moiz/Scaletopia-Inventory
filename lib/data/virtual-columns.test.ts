import { describe, expect, it } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { VirtualColumnFilter } from "@/lib/data/virtual-columns";

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

describe("virtual_filter_predicate_matches — list", () => {
  it("matches an exact member, not a near-string (a3 does not match a30)", async () => {
    const contains: VirtualColumnFilter = { key: "specialties", type: "list", operator: "contains", value: "a3" };
    expect(await matches({ specialties: ["a3", "a4"] }, contains)).toBe(true);
    expect(await matches({ specialties: ["a30"] }, contains)).toBe(false);
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

describe("virtual_filters_match", () => {
  it("matches every row when given an empty filter list (no active virtual filter)", async () => {
    const { data, error } = await supabaseAdmin.rpc("virtual_filters_match", {
      data: { anything: "goes" },
      filters: [],
    });
    if (error) throw error;
    expect(data).toBe(true);
  });

  it("ANDs multiple filters together", async () => {
    const filters: VirtualColumnFilter[] = [
      { key: "lead_score", type: "number", operator: "gt", value: 50 },
      { key: "tier", type: "text", operator: "is", value: "gold" },
    ];
    const { data: bothMatch, error: e1 } = await supabaseAdmin.rpc("virtual_filters_match", {
      data: { lead_score: 90, tier: "gold" },
      filters,
    });
    if (e1) throw e1;
    expect(bothMatch).toBe(true);

    const { data: oneMatches, error: e2 } = await supabaseAdmin.rpc("virtual_filters_match", {
      data: { lead_score: 90, tier: "silver" },
      filters,
    });
    if (e2) throw e2;
    expect(oneMatches).toBe(false);
  });
});
