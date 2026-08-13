import { describe, expect, it } from "vitest";
import { resolveDefaultFieldMapping } from "@/lib/push/resolve-default-field-mapping";
import type { ActiveVirtualColumn } from "@/lib/data/virtual-columns";
import type { GhlCustomField } from "@/lib/ghl/custom-fields";

function customField(overrides: Partial<GhlCustomField>): GhlCustomField {
  return { id: "field-1", name: "Field", fieldKey: "field", dataType: "TEXT", ...overrides };
}

function virtualColumn(key: string): ActiveVirtualColumn {
  return { key, type: "text" };
}

describe("resolveDefaultFieldMapping (ghl)", () => {
  it("defaults companyName to brandName when any record in the pushed set has a brand_name", () => {
    const result = resolveDefaultFieldMapping({
      platform: "ghl",
      records: [
        { companyName: "Acme Inc", brandName: null },
        { companyName: "Beta LLC", brandName: "Beta" },
      ],
      virtualColumns: [],
      customFields: [],
    });

    expect(result.standardFields.companyName).toBe("brandName");
  });

  it("defaults companyName to companyName when no record in the pushed set has a brand_name", () => {
    const result = resolveDefaultFieldMapping({
      platform: "ghl",
      records: [
        { companyName: "Acme Inc", brandName: null },
        { companyName: "Beta LLC", brandName: null },
      ],
      virtualColumns: [],
      customFields: [],
    });

    expect(result.standardFields.companyName).toBe("companyName");
  });

  it("defaults every other standard field to its own source column", () => {
    const result = resolveDefaultFieldMapping({
      platform: "ghl",
      records: [{ companyName: "Acme Inc", brandName: null }],
      virtualColumns: [],
      customFields: [],
    });

    expect(result.standardFields).toMatchObject({
      firstName: "firstName",
      lastName: "lastName",
      email: "email",
      phone: "phone",
      city: "city",
      country: "country",
    });
  });

  it("auto-selects a virtual column whose name closely matches a GHL custom field's name", () => {
    const result = resolveDefaultFieldMapping({
      platform: "ghl",
      records: [{ companyName: "Acme Inc", brandName: null }],
      virtualColumns: [virtualColumn("linkedin_headline"), virtualColumn("industry")],
      customFields: [customField({ id: "cf-1", name: "linkedin_headline" })],
    });

    expect(result.customFieldMapping).toEqual([
      { ghlFieldId: "cf-1", source: "column", columnKey: "linkedin_headline" },
    ]);
    expect(result.customFieldScores["cf-1"]).toBeGreaterThan(0);
  });

  it("auto-selects a standard GHL record field whose name closely matches a custom field's name", () => {
    const result = resolveDefaultFieldMapping({
      platform: "ghl",
      records: [{ companyName: "Acme Inc", brandName: null }],
      virtualColumns: [],
      customFields: [customField({ id: "cf-3", name: "First Name" })],
    });

    expect(result.customFieldMapping).toEqual([
      { ghlFieldId: "cf-3", source: "column", columnKey: "firstName" },
    ]);
  });

  it("defaults a custom field with no matching source to ignored (omitted from the mapping)", () => {
    const result = resolveDefaultFieldMapping({
      platform: "ghl",
      records: [{ companyName: "Acme Inc", brandName: null }],
      virtualColumns: [virtualColumn("industry")],
      customFields: [customField({ id: "cf-2", name: "Zzz Totally Unrelated Field" })],
    });

    expect(result.customFieldMapping).toEqual([]);
  });
});

describe("resolveDefaultFieldMapping (emailbison)", () => {
  it("defaults companyName to brandName when any record in the pushed set has one", () => {
    const result = resolveDefaultFieldMapping({
      platform: "emailbison",
      records: [{ companyName: "Acme Inc", brandName: "Acme" }],
    });

    expect(result.standardFields.companyName).toBe("brandName");
  });

  it("defaults companyName to companyName when no record in the pushed set has a brandName", () => {
    const result = resolveDefaultFieldMapping({
      platform: "emailbison",
      records: [{ companyName: "Acme Inc", brandName: null }],
    });

    expect(result.standardFields.companyName).toBe("companyName");
  });

  it("defaults every other standard field to its own source column", () => {
    const result = resolveDefaultFieldMapping({
      platform: "emailbison",
      records: [{ companyName: "Acme Inc", brandName: null }],
    });

    expect(result.standardFields).toMatchObject({
      firstName: "firstName",
      lastName: "lastName",
      email: "email",
      phone: "phone",
      title: "title",
      website: "website",
    });
  });
});
