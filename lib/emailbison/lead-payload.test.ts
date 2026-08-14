import { describe, expect, it } from "vitest";
import {
  buildEmailBisonLeadPayload,
  normalizeFieldSource,
  resolveCustomVariables,
} from "@/lib/emailbison/lead-payload";
import type { EmailBisonPushRecord, EmailBisonStandardFieldMapping } from "@/lib/emailbison/types";

const fullRecord: EmailBisonPushRecord = {
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.com",
  phone: "+15551234567",
  companyName: "Acme Inc",
  brandName: null,
  title: "VP Sales",
  website: "acme.com",
  city: null,
  state: null,
  country: null,
  fullName: "Jane Doe",
  linkedinUrl: null,
  linkedinUsername: null,
  phoneType: null,
  phoneStatus: null,
  emailStatus: null,
  sourceId: null,
  tags: null,
  emailVerifiedAt: null,
  phoneVerifiedAt: null,
  lastUpdated: null,
  createdAt: null,
  companyCity: null,
  companyState: null,
  companyCountry: null,
  companyIndustry: null,
  companyEmployeeCount: null,
  companyWebsiteUrl: null,
  companyLinkedinUrl: null,
  companyDomain: null,
  companyPhone: null,
  companyPhoneType: null,
  companyEmail: null,
  companyEmailStatus: null,
  companyNiche: null,
  companyQualityTier: null,
  companyPhoneStatus: null,
  companyClient: null,
  companyCreatedAt: null,
  companyDescription: null,
  companyDomainStatus: null,
  companyEmailVerifiedAt: null,
  companyFoundedYear: null,
  companyKeywords: null,
  companyLastUpdated: null,
  companyMxProvider: null,
  companyPhoneVerifiedAt: null,
  companyRevenue: null,
  companySecurityGateway: null,
  companySource: null,
  companyTags: null,
  companyTechnologies: null,
};

describe("buildEmailBisonLeadPayload", () => {
  it("shapes a full record into an EmailBison lead payload", () => {
    expect(buildEmailBisonLeadPayload(fullRecord, null)).toEqual({
      email: "jane@example.com",
      firstName: "Jane",
      lastName: "Doe",
      companyName: "Acme Inc",
      title: "VP Sales",
      phone: "+15551234567",
      website: "acme.com",
      existingLeadBehavior: "patch",
      customVariables: [],
    });
  });

  it("passes null fields through untouched", () => {
    const record: EmailBisonPushRecord = {
      firstName: null,
      lastName: null,
      email: null,
      phone: null,
      companyName: null,
      brandName: null,
      title: null,
      website: null,
      city: null,
      state: null,
      country: null,
      fullName: null,
      linkedinUrl: null,
      linkedinUsername: null,
      phoneType: null,
      phoneStatus: null,
      emailStatus: null,
      sourceId: null,
      tags: null,
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      lastUpdated: null,
      createdAt: null,
      companyCity: null,
      companyState: null,
      companyCountry: null,
      companyIndustry: null,
      companyEmployeeCount: null,
      companyWebsiteUrl: null,
      companyLinkedinUrl: null,
      companyDomain: null,
      companyPhone: null,
      companyPhoneType: null,
      companyEmail: null,
      companyEmailStatus: null,
      companyNiche: null,
      companyQualityTier: null,
      companyPhoneStatus: null,
      companyClient: null,
      companyCreatedAt: null,
      companyDescription: null,
      companyDomainStatus: null,
      companyEmailVerifiedAt: null,
      companyFoundedYear: null,
      companyKeywords: null,
      companyLastUpdated: null,
      companyMxProvider: null,
      companyPhoneVerifiedAt: null,
      companyRevenue: null,
      companySecurityGateway: null,
      companySource: null,
      companyTags: null,
      companyTechnologies: null,
    };
    expect(buildEmailBisonLeadPayload(record, null)).toEqual({
      email: null,
      firstName: null,
      lastName: null,
      companyName: null,
      title: null,
      phone: null,
      website: null,
      existingLeadBehavior: "patch",
      customVariables: [],
    });
  });

  it("defaults existingLeadBehavior to patch when omitted", () => {
    const result = buildEmailBisonLeadPayload(fullRecord, null);
    expect(result.existingLeadBehavior).toBe("patch");
  });

  it("applies an explicit existingLeadBehavior of put", () => {
    const result = buildEmailBisonLeadPayload(fullRecord, null, [], "put");
    expect(result.existingLeadBehavior).toBe("put");
  });

  it("carries selected custom-variable entries through as name/value pairs", () => {
    const customVariables = [
      { name: "lead_score", value: "87" },
      { name: "plan", value: "pro" },
    ];
    const result = buildEmailBisonLeadPayload(fullRecord, null, customVariables);
    expect(result.customVariables).toEqual(customVariables);
  });

  it("defaults customVariables to an empty array when omitted", () => {
    const result = buildEmailBisonLeadPayload(fullRecord, null);
    expect(result.customVariables).toEqual([]);
  });

  it("supports zero custom-variable entries", () => {
    const result = buildEmailBisonLeadPayload(fullRecord, null, []);
    expect(result.customVariables).toEqual([]);
  });

  it("prefers the cleaned brandName over the raw companyName", () => {
    const result = buildEmailBisonLeadPayload(
      { ...fullRecord, companyName: "ACME INC dba", brandName: "Acme" },
      null
    );
    expect(result.companyName).toBe("Acme");
  });

  it("falls back to the raw companyName when brandName is null", () => {
    const result = buildEmailBisonLeadPayload({ ...fullRecord, brandName: null }, null);
    expect(result.companyName).toBe("Acme Inc");
  });

  const fullMapping: EmailBisonStandardFieldMapping = {
    companyName: "brandName",
    firstName: "firstName",
    lastName: "lastName",
    email: "email",
    phone: "phone",
    title: "title",
    website: "website",
  };

  it("reproduces today's default behavior when standardFieldMapping is omitted", () => {
    const withMapping = buildEmailBisonLeadPayload(
      { ...fullRecord, brandName: "Acme" },
      null,
      [],
      "patch",
      fullMapping
    );
    const withoutMapping = buildEmailBisonLeadPayload({ ...fullRecord, brandName: "Acme" }, null);
    expect(withoutMapping).toEqual(withMapping);
  });

  it("falls back to the raw companyName when a present mapping sources companyName from brandName but brandName is null", () => {
    // The default mapping sends companyName: "brandName" for the whole push
    // whenever *any* record has a cleaned name; a brand-less record in that
    // set must still send its raw companyName, not null — reproducing the old
    // 3-way "brand_name" choice's brand-preferred-with-raw-fallback behavior.
    const result = buildEmailBisonLeadPayload(
      { ...fullRecord, companyName: "Acme Inc", brandName: null },
      null,
      [],
      "patch",
      fullMapping // companyName: "brandName"
    );
    expect(result.companyName).toBe("Acme Inc");
  });

  it("sends the raw companyName when the mapping sources it from companyName", () => {
    const result = buildEmailBisonLeadPayload(
      { ...fullRecord, companyName: "ACME INC dba", brandName: "Acme" },
      null,
      [],
      "patch",
      { ...fullMapping, companyName: "companyName" }
    );
    expect(result.companyName).toBe("ACME INC dba");
  });

  it("omits companyName when the mapping skips it", () => {
    const result = buildEmailBisonLeadPayload(fullRecord, null, [], "patch", {
      ...fullMapping,
      companyName: "skip",
    });
    expect(result.companyName).toBeNull();
  });

  it("omits any standard field the mapping sets to skip", () => {
    const result = buildEmailBisonLeadPayload(fullRecord, null, [], "patch", {
      ...fullMapping,
      firstName: "skip",
      phone: "skip",
      website: "skip",
    });
    expect(result.firstName).toBeNull();
    expect(result.phone).toBeNull();
    expect(result.website).toBeNull();
    expect(result.lastName).toBe("Doe");
  });

  it("resolves an EmailBison field from a source column different than its own", () => {
    const result = buildEmailBisonLeadPayload(fullRecord, null, [], "patch", {
      ...fullMapping,
      companyName: "website",
    });
    expect(result.companyName).toBe("acme.com");
  });

  it("resolves a standard field from custom_data when the mapping sources it from an enrichment column", () => {
    const result = buildEmailBisonLeadPayload(fullRecord, { seniority: "VP" }, [], "patch", {
      ...fullMapping,
      title: "seniority",
    });
    expect(result.title).toBe("VP");
  });

  it("sends a static value verbatim to every field the mapping sets to a literal", () => {
    const result = buildEmailBisonLeadPayload(fullRecord, null, [], "patch", {
      ...fullMapping,
      companyName: "literal:Acme Corp",
      title: "literal:Founder",
    });
    expect(result.companyName).toBe("Acme Corp");
    expect(result.title).toBe("Founder");
    // non-literal fields still resolve from their own column
    expect(result.firstName).toBe("Jane");
  });

  it("does not resolve a static value as a column key even when text collides with a field name", () => {
    const result = buildEmailBisonLeadPayload(fullRecord, null, [], "patch", {
      ...fullMapping,
      companyName: "literal:firstName",
    });
    expect(result.companyName).toBe("firstName");
  });

  it("sends an empty string when a field is a literal with no text typed", () => {
    const result = buildEmailBisonLeadPayload(fullRecord, null, [], "patch", {
      ...fullMapping,
      title: "literal:",
    });
    expect(result.title).toBe("");
  });

  it("tolerates a legacy 'include'/'brand_name' mapping saved before free-source mapping existed", () => {
    const legacyMapping: EmailBisonStandardFieldMapping = {
      companyName: "brand_name",
      firstName: "include",
      lastName: "include",
      email: "include",
      phone: "include",
      title: "include",
      website: "include",
    };
    const result = buildEmailBisonLeadPayload({ ...fullRecord, brandName: "Acme" }, null, [], "patch", legacyMapping);
    expect(result).toEqual(
      buildEmailBisonLeadPayload({ ...fullRecord, brandName: "Acme" }, null, [], "patch", fullMapping)
    );
  });
});

describe("normalizeFieldSource", () => {
  it("maps legacy 'include' to the field's own key", () => {
    expect(normalizeFieldSource("firstName", "include")).toBe("firstName");
    expect(normalizeFieldSource("companyName", "include")).toBe("companyName");
    expect(normalizeFieldSource("website", "include")).toBe("website");
  });

  it("maps legacy 'brand_name'/'company_name' to brandName/companyName", () => {
    expect(normalizeFieldSource("companyName", "brand_name")).toBe("brandName");
    expect(normalizeFieldSource("companyName", "company_name")).toBe("companyName");
  });

  it("keeps 'skip' as-is", () => {
    expect(normalizeFieldSource("email", "skip")).toBe("skip");
  });

  it("passes an already-normalized source key through unchanged", () => {
    expect(normalizeFieldSource("title", "some_enrichment_key")).toBe("some_enrichment_key");
  });
});

describe("resolveCustomVariables", () => {
  // "interests" (not "tags") — "tags" is now a real bindable person-record
  // field (KNOWN_RECORD_FIELDS), so a custom_data key literally named "tags"
  // would collide and resolve from the record instead of custom_data.
  const customData = { lead_score: 87, is_decision_maker: true, interests: ["a", "b"], empty: null };

  it("passes literal entries through untouched", () => {
    const entries = [{ name: "plan", value: "pro" }];
    expect(resolveCustomVariables(entries, fullRecord, null)).toEqual(entries);
  });

  it("resolves a column-bound entry from a known EmailBison record field", () => {
    const entries = [{ name: "company", value: "", columnKey: "companyName" }];
    expect(resolveCustomVariables(entries, fullRecord, null)).toEqual([
      { name: "company", value: "Acme Inc" },
    ]);
  });

  it("resolves a brandName-bound entry to the cleaned company name", () => {
    const entries = [{ name: "company", value: "", columnKey: "brandName" }];
    const record = { ...fullRecord, companyName: "ACME INC dba", brandName: "Acme" };
    expect(resolveCustomVariables(entries, record, null)).toEqual([{ name: "company", value: "Acme" }]);
  });

  it("resolves a companyName-bound entry to the raw name even when brandName is present", () => {
    const entries = [{ name: "company", value: "", columnKey: "companyName" }];
    const record = { ...fullRecord, companyName: "ACME INC dba", brandName: "Acme" };
    expect(resolveCustomVariables(entries, record, null)).toEqual([{ name: "company", value: "ACME INC dba" }]);
  });

  it("resolves a column-bound entry from custom_data (virtual column)", () => {
    const entries = [{ name: "score", value: "", columnKey: "lead_score" }];
    expect(resolveCustomVariables(entries, fullRecord, customData)).toEqual([
      { name: "score", value: "87" },
    ]);
  });

  it("stringifies booleans, numbers, and arrays from custom_data", () => {
    const entries = [
      { name: "dm", value: "", columnKey: "is_decision_maker" },
      { name: "tags", value: "", columnKey: "interests" },
    ];
    expect(resolveCustomVariables(entries, fullRecord, customData)).toEqual([
      { name: "dm", value: "true" },
      { name: "tags", value: '["a","b"]' },
    ]);
  });

  it("omits a column-bound entry whose resolved value is null or missing", () => {
    const entries = [
      { name: "empty", value: "", columnKey: "empty" },
      { name: "missing", value: "", columnKey: "does_not_exist" },
      { name: "plan", value: "pro" },
    ];
    expect(resolveCustomVariables(entries, fullRecord, customData)).toEqual([{ name: "plan", value: "pro" }]);
  });

  it("omits a column-bound entry when custom_data is null", () => {
    const entries = [{ name: "score", value: "", columnKey: "lead_score" }];
    expect(resolveCustomVariables(entries, fullRecord, null)).toEqual([]);
  });
});
