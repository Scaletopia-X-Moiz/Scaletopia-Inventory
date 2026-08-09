import { describe, expect, it } from "vitest";
import { buildGhlContactPayload, buildGhlCustomFields } from "@/lib/ghl/contact-payload";
import type { GhlFieldMapping } from "@/lib/ghl/types";

const fullRecord = {
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.com",
  phone: "+15551234567",
  companyName: "Acme Inc",
  brandName: null,
  city: "Austin",
  country: "US",
};

describe("buildGhlContactPayload", () => {
  it("shapes a full record into a GHL contact payload", () => {
    expect(buildGhlContactPayload(fullRecord, ["Acme - dtc-beauty | 11-50 | US | apollo"])).toEqual(
      {
        firstName: "Jane",
        lastName: "Doe",
        email: "jane@example.com",
        phone: "+15551234567",
        companyName: "Acme Inc",
        city: "Austin",
        country: "US",
        tags: ["Acme - dtc-beauty | 11-50 | US | apollo"],
        customFields: [],
      }
    );
  });

  it("passes null fields through untouched", () => {
    const record = {
      firstName: null,
      lastName: null,
      email: null,
      phone: null,
      companyName: null,
      brandName: null,
      city: null,
      country: null,
    };
    expect(buildGhlContactPayload(record, [])).toEqual({
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
      []
    );
    expect(result.companyName).toBe("Acme");
  });

  it("falls back to the raw companyName when brandName is null", () => {
    const result = buildGhlContactPayload({ ...fullRecord, brandName: null }, []);
    expect(result.companyName).toBe("Acme Inc");
  });

  it("supports attaching more than one tag", () => {
    const result = buildGhlContactPayload(fullRecord, ["tag-a", "tag-b"]);
    expect(result.tags).toEqual(["tag-a", "tag-b"]);
  });

  it("supports zero tags", () => {
    const result = buildGhlContactPayload(fullRecord, []);
    expect(result.tags).toEqual([]);
  });

  it("carries a supplied customFields array through untouched", () => {
    const customFields = [{ id: "f1", value: "42" }];
    const result = buildGhlContactPayload(fullRecord, [], customFields);
    expect(result.customFields).toEqual(customFields);
  });

  it("defaults customFields to an empty array when omitted", () => {
    const result = buildGhlContactPayload(fullRecord, []);
    expect(result.customFields).toEqual([]);
  });

  it("sends the raw company_name even when brand_name is present, given companyName: \"company_name\"", () => {
    const result = buildGhlContactPayload(
      { ...fullRecord, companyName: "ACME INC dba", brandName: "Acme" },
      [],
      [],
      {
        companyName: "company_name",
        firstName: "include",
        lastName: "include",
        email: "include",
        phone: "include",
        city: "include",
        country: "include",
      }
    );
    expect(result.companyName).toBe("ACME INC dba");
  });

  it("omits company name entirely when the mapping is companyName: \"skip\"", () => {
    const result = buildGhlContactPayload(fullRecord, [], [], {
      companyName: "skip",
      firstName: "include",
      lastName: "include",
      email: "include",
      phone: "include",
      city: "include",
      country: "include",
    });
    expect(result.companyName).toBeNull();
  });

  it("still prefers brand_name over company_name when the mapping says brand_name", () => {
    const result = buildGhlContactPayload(
      { ...fullRecord, companyName: "ACME INC dba", brandName: "Acme" },
      [],
      [],
      {
        companyName: "brand_name",
        firstName: "include",
        lastName: "include",
        email: "include",
        phone: "include",
        city: "include",
        country: "include",
      }
    );
    expect(result.companyName).toBe("Acme");
  });

  it("nulls out any field set to \"skip\"", () => {
    const result = buildGhlContactPayload(fullRecord, [], [], {
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
    const withoutMapping = buildGhlContactPayload(fullRecord, ["tag"], []);
    const withUndefinedMapping = buildGhlContactPayload(fullRecord, ["tag"], [], undefined);
    expect(withoutMapping).toEqual(withUndefinedMapping);
    expect(withoutMapping.companyName).toBe(fullRecord.companyName);
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
    const record = {
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

  it("prefers brandName over companyName for a column entry bound to companyName", () => {
    const record = {
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
    };
    const result = buildGhlCustomFields(null, [{ ghlFieldId: "f7", source: "column", columnKey: "companyName" }], record);
    expect(result).toEqual([{ id: "f7", value: "Acme" }]);
  });
});
