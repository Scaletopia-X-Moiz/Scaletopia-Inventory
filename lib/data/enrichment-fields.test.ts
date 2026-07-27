import { describe, expect, it } from "vitest";
import { getCompanyEnrichmentFields, getPersonEnrichmentFields } from "@/lib/data/enrichment-fields";
import { supabaseAdmin } from "@/lib/supabase/admin";

const VALID_TYPES = ["Text", "Number", "Boolean", "List", "Date"];

// Same fixed blocklist as lib/data/custom-data.ts's isHousekeepingKey — a
// discovered field must never be one of these, or start/end with the
// housekeeping prefixes/suffixes.
function isBlockedKey(key: string): boolean {
  const blocked = new Set([
    "naics",
    "aiark_id",
    "industries",
    "legal_name",
    "ai_ark_approaches",
    "pushed_to_clay",
    "created_at",
    "updated_at",
    "company_type",
  ]);
  return blocked.has(key) || key.startsWith("pushed_to_") || key.endsWith("_at");
}

describe("getCompanyEnrichmentFields", () => {
  it("discovers enrichment keys on the unfiltered table with plausible types", async () => {
    const result = await getCompanyEnrichmentFields();

    expect(result.fields.length).toBeGreaterThan(0);
    for (const field of result.fields) {
      expect(VALID_TYPES).toContain(field.type);
      expect(isBlockedKey(field.key)).toBe(false);
    }

    // Real custom_data carries a "Company Type" free-text category label on
    // most rows (distinct from the blocklisted snake_case "company_type") —
    // confirmed present with a large-enough sample that it must surface.
    const companyType = result.fields.find((f) => f.key === "Company Type");
    expect(companyType).toBeDefined();
    expect(companyType?.type).toBe("Text");
  }, 30000);

  it("never surfaces a blocklisted key even if present in custom_data", async () => {
    const result = await getCompanyEnrichmentFields();
    const keys = result.fields.map((f) => f.key);

    expect(keys).not.toContain("naics");
    expect(keys).not.toContain("created_at");
    expect(keys).not.toContain("company_type");
    expect(keys.some((k) => k.startsWith("pushed_to_"))).toBe(false);
  }, 30000);

  it("caps sample values per key and bounds the sampled row count", async () => {
    const sampleSize = 50;
    const maxValues = 5;
    const result = await getCompanyEnrichmentFields({}, sampleSize, maxValues);

    expect(result.sampledRows).toBeLessThanOrEqual(sampleSize);
    for (const field of result.fields) {
      expect(field.sampleValues.length).toBeLessThanOrEqual(maxValues);
      expect(new Set(field.sampleValues).size).toBe(field.sampleValues.length);
    }
  }, 30000);

  it("scopes discovery to the active filters, not the whole table", async () => {
    const all = await getCompanyEnrichmentFields({}, 2000);
    const filtered = await getCompanyEnrichmentFields({ search: "zzzzzznonexistentxyz" }, 2000);

    expect(filtered.sampledRows).toBe(0);
    expect(filtered.fields).toHaveLength(0);
    expect(all.sampledRows).toBeGreaterThan(0);
  }, 30000);
});

describe("enrichment_field_discovery (type inference, direct)", () => {
  async function discover(samples: Record<string, unknown>[]) {
    const { data, error } = await supabaseAdmin.rpc("enrichment_field_discovery", {
      samples,
      extra_blocked_keys: [],
      max_values_per_key: 25,
    });
    if (error) throw error;
    return data as { key: string; type: string; sampleValues: string[] }[];
  }

  it("infers the dominant non-empty shape, breaking ties alphabetically by type", async () => {
    const fields = await discover([
      { lead_score: 90 },
      { lead_score: 85 },
      { lead_score: "not a number" },
    ]);
    expect(fields.find((f) => f.key === "lead_score")?.type).toBe("Number");
  }, 30000);

  it("treats an empty array as Empty, not List, for type inference", async () => {
    const fields = await discover([{ specialties: [] }, { specialties: [] }]);
    expect(fields.find((f) => f.key === "specialties")?.type).toBe("Text");
  }, 30000);

  it("classifies a real array as List and flattens elements into sampleValues", async () => {
    const fields = await discover([{ specialties: ["a3", "a4"] }, { specialties: ["a3"] }]);
    const field = fields.find((f) => f.key === "specialties");
    expect(field?.type).toBe("List");
    expect(field?.sampleValues.sort()).toEqual(["a3", "a4"]);
  }, 30000);

  it("normalizes '-' sentinels, whitespace, and unrendered Clay templates to Empty", async () => {
    const fields = await discover([
      { followers: 329 },
      { followers: "-" },
      { followers: "  " },
      { followers: "{{ 0 }}" },
    ]);
    const field = fields.find((f) => f.key === "followers");
    expect(field?.type).toBe("Number");
    expect(field?.sampleValues).toEqual(["329"]);
  }, 30000);

  it("excludes blocklisted keys entirely", async () => {
    const fields = await discover([{ naics: "1234", created_at: "2026-01-01", followers: 329 }]);
    const keys = fields.map((f) => f.key);
    expect(keys).toEqual(["followers"]);
  }, 30000);
});

describe("getPersonEnrichmentFields", () => {
  it("discovers enrichment keys on the unfiltered table with plausible types", async () => {
    const result = await getPersonEnrichmentFields();

    for (const field of result.fields) {
      expect(VALID_TYPES).toContain(field.type);
      expect(isBlockedKey(field.key)).toBe(false);
    }
    // People-specific extra blocklist (PERSON_EXTRA_BLOCKED_KEYS in
    // lib/data/people.ts) must also never surface.
    const keys = result.fields.map((f) => f.key);
    expect(keys).not.toContain("company_linkedin_id");
    expect(keys).not.toContain("connections_count");
    expect(keys).not.toContain("apollo_id");
  }, 30000);
});
