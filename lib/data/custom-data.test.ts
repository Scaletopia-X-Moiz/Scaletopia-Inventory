import { describe, expect, it } from "vitest";
import { filterCustomData, toWebhookCustomData } from "@/lib/data/custom-data";

describe("filterCustomData", () => {
  it("drops the fixed blocklist regardless of value", () => {
    const result = filterCustomData({
      naics: "1234",
      aiark_id: "abc",
      industries: ["x"],
      legal_name: "Acme Inc",
      ai_ark_approaches: ["foo"],
      pushed_to_clay: true,
      created_at: "2026-01-01",
      updated_at: "2026-01-01",
      company_type: "Privately Held",
      "core service": "consulting",
    });
    expect(result).toEqual({ "core service": "consulting" });
  });

  it("drops any pushed_to_* or *_at housekeeping key", () => {
    const result = filterCustomData({
      pushed_to_emailbison: true,
      pushed_to_emailbison_at: "2026-01-01",
      pushed_to_ghl: false,
      imported_at: "2026-01-01",
      followers: 329,
    });
    expect(result).toEqual({ followers: 329 });
  });

  it("drops null, empty string, and empty array values", () => {
    const result = filterCustomData({
      specialties: null,
      tagline: "",
      competitors: [],
      followers: 329,
      broadened_pull: true,
    });
    expect(result).toEqual({ followers: 329, broadened_pull: true });
  });

  it("supports keys containing spaces", () => {
    const result = filterCustomData({ "core service": "customer_support_outsourcing" });
    expect(result).toEqual({ "core service": "customer_support_outsourcing" });
  });

  it("applies extra blocklist keys for Person Detail", () => {
    const result = filterCustomData(
      { company_linkedin_id: "1", connections_count: 50, job_title: "Founder" },
      ["company_linkedin_id", "connections_count"]
    );
    expect(result).toEqual({ job_title: "Founder" });
  });

  it("returns an empty object when everything is filtered out", () => {
    expect(filterCustomData({ naics: "1234", empty: "" })).toEqual({});
  });

  it("handles null/undefined input", () => {
    expect(filterCustomData(null)).toEqual({});
    expect(filterCustomData(undefined)).toEqual({});
  });
});

describe("toWebhookCustomData", () => {
  it("strips only pushed_to_clay and pushed_to_clay_at", () => {
    const result = toWebhookCustomData({
      pushed_to_clay: true,
      pushed_to_clay_at: "2026-01-01",
      followers: 329,
    });
    expect(result).toEqual({ followers: 329 });
  });

  it("keeps every other key, including nulls, empty strings, empty arrays, and *_at fields", () => {
    const result = toWebhookCustomData({
      specialties: null,
      tagline: "",
      competitors: [],
      founded_at: "2010-01-01",
      pushed_to_emailbison: true,
      followers: 329,
    });
    expect(result).toEqual({
      specialties: null,
      tagline: "",
      competitors: [],
      founded_at: "2010-01-01",
      pushed_to_emailbison: true,
      followers: 329,
    });
  });

  it("handles null/undefined input", () => {
    expect(toWebhookCustomData(null)).toEqual({});
    expect(toWebhookCustomData(undefined)).toEqual({});
  });
});
