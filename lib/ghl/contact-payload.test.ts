import { describe, expect, it } from "vitest";
import { buildGhlContactPayload, buildGhlCustomFields, normalizeGhlFieldSource } from "@/lib/ghl/contact-payload";
import type { GhlFieldMapping, GhlPushRecord, GhlStandardFieldMapping } from "@/lib/ghl/types";

const NULL_GHL_EXTRA_FIELDS = {
  title: null,
  website: null,
  state: null,
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
  companyWebsiteUrl: null,
  companyLinkedinUrl: null,
  companyDomain: null,
  companyPhone: null,
  companyPhoneType: null,
  companyPhoneStatus: null,
  companyEmail: null,
  companyEmailStatus: null,
  companyEmailVerifiedAt: null,
  companyPhoneVerifiedAt: null,
  companyQualityTier: null,
  companyClient: null,
  companyDescription: null,
  companyFoundedYear: null,
  companyRevenue: null,
  companyDomainStatus: null,
  companyMxProvider: null,
  companySecurityGateway: null,
  companyKeywords: null,
  companyTechnologies: null,
  companyTags: null,
  companyCreatedAt: null,
  companyLastUpdated: null,
} satisfies Partial<GhlPushRecord>;

const fullRecord: GhlPushRecord = {
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.com",
  phone: "+15551234567",
  companyName: "Acme Inc",
  brandName: null,
  city: "Austin",
  country: "US",
  niche: "dtc-beauty",
  employeeCount: 42,
  source: "apollo",
  ...NULL_GHL_EXTRA_FIELDS,
};

describe("buildGhlContactPayload", () => {
  it("shapes a full record into a GHL contact payload", () => {
    expect(
      buildGhlContactPayload(fullRecord, null, ["Acme - dtc-beauty | 11-50 | US | apollo"])
    ).toEqual({
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: "+15551234567",
      companyName: "Acme Inc",
      city: "Austin",
      country: "US",
      tags: ["Acme - dtc-beauty | 11-50 | US | apollo"],
      customFields: [],
    });
  });

  it("passes null fields through untouched", () => {
    const record: GhlPushRecord = {
      firstName: null,
      lastName: null,
      email: null,
      phone: null,
      companyName: null,
      brandName: null,
      city: null,
      country: null,
      niche: null,
      employeeCount: null,
      source: null,
      ...NULL_GHL_EXTRA_FIELDS,
    };
    expect(buildGhlContactPayload(record, null, [])).toEqual({
      firstName: null,
      lastName: null,
      email: null,
      phone: null,
      companyName: null,
      city: null,
      country: null,
      tags: [],
      customFields: [],
    });
  });

  it("prefers the cleaned brandName over the raw companyName", () => {
    const result = buildGhlContactPayload(
      { ...fullRecord, companyName: "ACME INC dba", brandName: "Acme" },
      null,
      []
    );
    expect(result.companyName).toBe("Acme");
  });

  it("falls back to the raw companyName when brandName is null", () => {
    const result = buildGhlContactPayload({ ...fullRecord, brandName: null }, null, []);
    expect(result.companyName).toBe("Acme Inc");
  });

  it("supports attaching more than one tag", () => {
    const result = buildGhlContactPayload(fullRecord, null, ["tag-a", "tag-b"]);
    expect(result.tags).toEqual(["tag-a", "tag-b"]);
  });

  it("supports zero tags", () => {
    const result = buildGhlContactPayload(fullRecord, null, []);
    expect(result.tags).toEqual([]);
  });

  it("carries a supplied customFields array through untouched", () => {
    const customFields = [{ id: "f1", value: "42" }];
    const result = buildGhlContactPayload(fullRecord, null, [], customFields);
    expect(result.customFields).toEqual(customFields);
  });

  it("defaults customFields to an empty array when omitted", () => {
    const result = buildGhlContactPayload(fullRecord, null, []);
    expect(result.customFields).toEqual([]);
  });

  const fullMapping: GhlStandardFieldMapping = {
    companyName: "brandName",
    firstName: "firstName",
    lastName: "lastName",
    email: "email",
    phone: "phone",
    city: "city",
    country: "country",
  };

  it("sends the raw companyName even when brandName is present, given companyName sourced from companyName", () => {
    const result = buildGhlContactPayload(
      { ...fullRecord, companyName: "ACME INC dba", brandName: "Acme" },
      null,
      [],
      [],
      { ...fullMapping, companyName: "companyName" }
    );
    expect(result.companyName).toBe("ACME INC dba");
  });

  it("omits company name entirely when the mapping skips it", () => {
    const result = buildGhlContactPayload(fullRecord, null, [], [], { ...fullMapping, companyName: "skip" });
    expect(result.companyName).toBeNull();
  });

  it("still prefers brandName over companyName when the mapping sources companyName from brandName", () => {
    const result = buildGhlContactPayload(
      { ...fullRecord, companyName: "ACME INC dba", brandName: "Acme" },
      null,
      [],
      [],
      fullMapping // companyName: "brandName"
    );
    expect(result.companyName).toBe("Acme");
  });

  it("falls back to the raw companyName when a present mapping sources companyName from brandName but brandName is null", () => {
    // The default mapping sends companyName: "brandName" for the whole push
    // whenever *any* record has a cleaned name; a brand-less record in that
    // set must still send its raw companyName, not null — reproducing the old
    // 3-way "brand_name" choice's brand-preferred-with-raw-fallback behavior.
    const result = buildGhlContactPayload(
      { ...fullRecord, companyName: "Acme Inc", brandName: null },
      null,
      [],
      [],
      fullMapping
    );
    expect(result.companyName).toBe("Acme Inc");
  });

  it("sends a static value verbatim to every field the mapping sets to a literal", () => {
    const result = buildGhlContactPayload(fullRecord, null, [], [], {
      ...fullMapping,
      companyName: "literal:Acme Corp",
      city: "literal:Remote",
    });
    expect(result.companyName).toBe("Acme Corp");
    expect(result.city).toBe("Remote");
    // non-literal fields still resolve from their own column
    expect(result.firstName).toBe("Jane");
  });

  it("does not resolve a static value as a column key even when text collides with a field name", () => {
    const result = buildGhlContactPayload(fullRecord, null, [], [], {
      ...fullMapping,
      city: "literal:firstName",
    });
    expect(result.city).toBe("firstName");
  });

  it("nulls out any field set to skip", () => {
    const result = buildGhlContactPayload(fullRecord, null, [], [], {
      companyName: "skip",
      firstName: "skip",
      lastName: "skip",
      email: "skip",
      phone: "skip",
      city: "skip",
      country: "skip",
    });
    expect(result).toEqual({
      firstName: null,
      lastName: null,
      email: null,
      phone: null,
      companyName: null,
      city: null,
      country: null,
      tags: [],
      customFields: [],
    });
  });

  it("reproduces today's behavior exactly when the mapping is omitted", () => {
    const withoutMapping = buildGhlContactPayload(fullRecord, null, ["tag"], []);
    const withUndefinedMapping = buildGhlContactPayload(fullRecord, null, ["tag"], [], undefined);
    expect(withoutMapping).toEqual(withUndefinedMapping);
    expect(withoutMapping.companyName).toBe(fullRecord.companyName);
  });

  it("resolves a GHL field from a source column different than its own", () => {
    const result = buildGhlContactPayload(fullRecord, null, [], [], {
      ...fullMapping,
      companyName: "employeeCount",
    });
    expect(result.companyName).toBe("42");
  });

  it("resolves a standard field from custom_data when the mapping sources it from an enrichment column", () => {
    const result = buildGhlContactPayload(fullRecord, { seniority: "VP" }, [], [], {
      ...fullMapping,
      city: "seniority",
    });
    expect(result.city).toBe("VP");
  });

  it("stringifies a standard field sourced from a numeric field", () => {
    const result = buildGhlContactPayload(fullRecord, null, [], [], {
      ...fullMapping,
      city: "employeeCount",
    });
    expect(result.city).toBe("42");
  });

  it("tolerates a legacy 'include'/'brand_name' mapping saved before free-source mapping existed", () => {
    const legacyMapping: GhlStandardFieldMapping = {
      companyName: "brand_name",
      firstName: "include",
      lastName: "include",
      email: "include",
      phone: "include",
      city: "include",
      country: "include",
    };
    const result = buildGhlContactPayload(
      { ...fullRecord, brandName: "Acme" },
      null,
      [],
      [],
      legacyMapping
    );
    expect(result).toEqual(
      buildGhlContactPayload({ ...fullRecord, brandName: "Acme" }, null, [], [], fullMapping)
    );
  });

  it("tolerates a legacy 'company_name' companyName value", () => {
    const result = buildGhlContactPayload(
      { ...fullRecord, companyName: "ACME INC dba", brandName: "Acme" },
      null,
      [],
      [],
      { ...fullMapping, companyName: "company_name" }
    );
    expect(result.companyName).toBe("ACME INC dba");
  });
});

describe("normalizeGhlFieldSource", () => {
  it("maps legacy 'include' to the field's own key", () => {
    expect(normalizeGhlFieldSource("firstName", "include")).toBe("firstName");
    expect(normalizeGhlFieldSource("companyName", "include")).toBe("companyName");
    expect(normalizeGhlFieldSource("city", "include")).toBe("city");
  });

  it("maps legacy 'brand_name'/'company_name' to brandName/companyName", () => {
    expect(normalizeGhlFieldSource("companyName", "brand_name")).toBe("brandName");
    expect(normalizeGhlFieldSource("companyName", "company_name")).toBe("companyName");
  });

  it("keeps 'skip' as-is", () => {
    expect(normalizeGhlFieldSource("email", "skip")).toBe("skip");
  });

  it("passes an already-normalized source key through unchanged", () => {
    expect(normalizeGhlFieldSource("country", "some_enrichment_key")).toBe("some_enrichment_key");
  });
});

describe("buildGhlCustomFields", () => {
  const mapping: GhlFieldMapping[] = [
    { ghlFieldId: "f1", source: "column", columnKey: "lead_score" },
    { ghlFieldId: "f2", source: "column", columnKey: "plan" },
  ];

  it("maps each mapped virtual-column key to its GHL field id/value", () => {
    const result = buildGhlCustomFields({ lead_score: 87, plan: "pro" }, mapping);
    expect(result).toEqual([
      { id: "f1", value: "87" },
      { id: "f2", value: "pro" },
    ]);
  });

  it("skips a mapping whose value is missing, null, or an empty string", () => {
    const result = buildGhlCustomFields({ lead_score: null, plan: "" }, mapping);
    expect(result).toEqual([]);
  });

  it("skips a mapping whose key isn't present in custom_data at all", () => {
    const result = buildGhlCustomFields({ plan: "pro" }, [
      { ghlFieldId: "f9", source: "column", columnKey: "missing_key" },
    ]);
    expect(result).toEqual([]);
  });

  it("returns an empty array when custom_data is null but the mapping is column-sourced", () => {
    expect(buildGhlCustomFields(null, mapping)).toEqual([]);
  });

  it("returns an empty array when no mapping is supplied", () => {
    expect(buildGhlCustomFields({ lead_score: 87 }, [])).toEqual([]);
  });

  it("joins a list-type value with a comma-space delimiter (not JSON-encoded, unlike EmailBison)", () => {
    const result = buildGhlCustomFields({ specialties: ["seo", "ppc", "email"] }, [
      { ghlFieldId: "f3", source: "column", columnKey: "specialties" },
    ]);
    expect(result).toEqual([{ id: "f3", value: "seo, ppc, email" }]);
  });

  it("skips a mapping whose list-type value is an empty array", () => {
    const result = buildGhlCustomFields({ specialties: [] }, [
      { ghlFieldId: "f3", source: "column", columnKey: "specialties" },
    ]);
    expect(result).toEqual([]);
  });

  it("stringifies non-string values (numbers, booleans)", () => {
    const result = buildGhlCustomFields(
      { lead_score: 87, plan: true },
      [
        { ghlFieldId: "f1", source: "column", columnKey: "lead_score" },
        { ghlFieldId: "f2", source: "column", columnKey: "plan" },
      ]
    );
    expect(result).toEqual([
      { id: "f1", value: "87" },
      { id: "f2", value: "true" },
    ]);
  });

  it("sends a literal entry's value verbatim, ignoring custom_data entirely", () => {
    const result = buildGhlCustomFields(null, [{ ghlFieldId: "f4", source: "literal", value: "static-value" }]);
    expect(result).toEqual([{ id: "f4", value: "static-value" }]);
  });

  it("resolves a column entry bound to a standard record field", () => {
    const record: GhlPushRecord = {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: "+15551234567",
      companyName: "Acme Inc",
      brandName: null,
      city: "Austin",
      country: "US",
      niche: "dtc-beauty",
      employeeCount: 42,
      source: "apollo",
      ...NULL_GHL_EXTRA_FIELDS,
    };
    const result = buildGhlCustomFields(
      null,
      [
        { ghlFieldId: "f5", source: "column", columnKey: "niche" },
        { ghlFieldId: "f6", source: "column", columnKey: "employeeCount" },
      ],
      record
    );
    expect(result).toEqual([
      { id: "f5", value: "dtc-beauty" },
      { id: "f6", value: "42" },
    ]);
  });

  it("resolves a column entry bound to companyName as the raw value even when brandName is present (pure lookup, no special-casing)", () => {
    const record: GhlPushRecord = {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: "+15551234567",
      companyName: "ACME INC dba",
      brandName: "Acme",
      city: "Austin",
      country: "US",
      niche: null,
      employeeCount: null,
      source: null,
      ...NULL_GHL_EXTRA_FIELDS,
    };
    const result = buildGhlCustomFields(null, [{ ghlFieldId: "f7", source: "column", columnKey: "companyName" }], record);
    expect(result).toEqual([{ id: "f7", value: "ACME INC dba" }]);
  });

  it("resolves a column entry bound to brandName independently of companyName", () => {
    const record: GhlPushRecord = {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: "+15551234567",
      companyName: "ACME INC dba",
      brandName: "Acme",
      city: "Austin",
      country: "US",
      niche: null,
      employeeCount: null,
      source: null,
      ...NULL_GHL_EXTRA_FIELDS,
    };
    const result = buildGhlCustomFields(null, [{ ghlFieldId: "f8", source: "column", columnKey: "brandName" }], record);
    expect(result).toEqual([{ id: "f8", value: "Acme" }]);
  });
});
