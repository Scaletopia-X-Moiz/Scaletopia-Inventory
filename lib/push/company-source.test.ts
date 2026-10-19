import { describe, expect, it } from "vitest";
import {
  buildPeoplePushBindableColumns,
  companyCustomKeyName,
  isCompanyCustomKey,
  resolveCompanyCustomValue,
  toCompanyCustomKey,
  toCompanyDiscoveryParams,
  usesCompanyCustomData,
} from "@/lib/push/company-source";

const RECORD_COLUMNS = [
  { key: "firstName", label: "First name" },
  { key: "city", label: "City" },
];

describe("company-source key encoding", () => {
  it("round-trips a key and never treats a plain key as company-bound", () => {
    const bound = toCompanyCustomKey("speciality_therapy");
    expect(isCompanyCustomKey(bound)).toBe(true);
    expect(companyCustomKeyName(bound)).toBe("speciality_therapy");
    expect(isCompanyCustomKey("speciality_therapy")).toBe(false);
    expect(isCompanyCustomKey("city")).toBe(false);
  });

  it("resolves from company custom_data, null when absent", () => {
    const key = toCompanyCustomKey("speciality_therapy");
    expect(resolveCompanyCustomValue(key, { speciality_therapy: "trauma therapy" })).toBe("trauma therapy");
    expect(resolveCompanyCustomValue(key, {})).toBeNull();
    expect(resolveCompanyCustomValue(key, null)).toBeNull();
    expect(resolveCompanyCustomValue(key, undefined)).toBeNull();
  });

  it("detects whether any binding needs the company blob", () => {
    expect(usesCompanyCustomData(["firstName", undefined, "skip", "literal:x"])).toBe(false);
    expect(usesCompanyCustomData(["firstName", toCompanyCustomKey("k")])).toBe(true);
  });
});

describe("buildPeoplePushBindableColumns", () => {
  it("offers company keys after person keys, in their own group, as company-source keys", () => {
    const columns = buildPeoplePushBindableColumns(
      RECORD_COLUMNS,
      [],
      [{ key: "lead_score" }],
      [{ key: "speciality_therapy" }]
    );
    expect(columns).toEqual([
      ...RECORD_COLUMNS,
      { key: "lead_score", label: "lead_score" },
      { key: "company_custom:speciality_therapy", label: "speciality_therapy", group: "company" },
    ]);
  });

  it("dedupes by source+key: the same key on person and company stays two options", () => {
    const columns = buildPeoplePushBindableColumns(
      RECORD_COLUMNS,
      [],
      [{ key: "score" }, { key: "score" }],
      [{ key: "score" }, { key: "score" }]
    );
    expect(columns.filter((c) => c.label === "score").map((c) => c.key)).toEqual(["score", "company_custom:score"]);
  });

  it("binds a company-source virtual column to the company, a person one to the person", () => {
    const columns = buildPeoplePushBindableColumns(
      RECORD_COLUMNS,
      [{ key: "a", source: "company" }, { key: "b", source: "person" }, { key: "c" }],
      [],
      [{ key: "a" }]
    );
    expect(columns.slice(RECORD_COLUMNS.length)).toEqual([
      { key: "b", label: "b" },
      { key: "c", label: "c" },
      { key: "company_custom:a", label: "a", group: "company" },
    ]);
  });
});

describe("toCompanyDiscoveryParams", () => {
  it("keeps only facets that mean the same on a company, dropping people-only filters", () => {
    const out = new URLSearchParams(
      toCompanyDiscoveryParams(
        "niche=therapy&niche_exclude=x&industry=Health&country=US&employee=11-50&empmin=5&phoneType=mobile&emailStatus=valid&title=ceo&pushStatus=pushed&q=bob&page=2"
      )
    );
    expect([...out.keys()].sort()).toEqual(["country", "employee", "empmin", "industry", "niche", "niche_exclude"]);
    expect(out.get("niche")).toBe("therapy");
  });

  it("is empty when no shared facet is active", () => {
    expect(toCompanyDiscoveryParams("phoneType=mobile&q=bob")).toBe("");
  });
});
