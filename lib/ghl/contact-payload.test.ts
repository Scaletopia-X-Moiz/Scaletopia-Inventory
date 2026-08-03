import { describe, expect, it } from "vitest";
import { buildGhlContactPayload, buildGhlCustomFields } from "@/lib/ghl/contact-payload";

const fullRecord = {
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.com",
  phone: "+15551234567",
  companyName: "Acme Inc",
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
});

describe("buildGhlCustomFields", () => {
  const mapping = [
    { virtualColumnKey: "lead_score", ghlFieldId: "f1" },
    { virtualColumnKey: "plan", ghlFieldId: "f2" },
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
      { virtualColumnKey: "missing_key", ghlFieldId: "f9" },
    ]);
    expect(result).toEqual([]);
  });

  it("returns an empty array when custom_data is null", () => {
    expect(buildGhlCustomFields(null, mapping)).toEqual([]);
  });

  it("returns an empty array when no mapping is supplied", () => {
    expect(buildGhlCustomFields({ lead_score: 87 }, [])).toEqual([]);
  });

  it("joins a list-type value with a comma-space delimiter", () => {
    const result = buildGhlCustomFields({ specialties: ["seo", "ppc", "email"] }, [
      { virtualColumnKey: "specialties", ghlFieldId: "f3" },
    ]);
    expect(result).toEqual([{ id: "f3", value: "seo, ppc, email" }]);
  });

  it("skips a mapping whose list-type value is an empty array", () => {
    const result = buildGhlCustomFields({ specialties: [] }, [
      { virtualColumnKey: "specialties", ghlFieldId: "f3" },
    ]);
    expect(result).toEqual([]);
  });

  it("stringifies non-string values (numbers, booleans)", () => {
    const result = buildGhlCustomFields(
      { lead_score: 87, plan: true },
      [
        { virtualColumnKey: "lead_score", ghlFieldId: "f1" },
        { virtualColumnKey: "plan", ghlFieldId: "f2" },
      ]
    );
    expect(result).toEqual([
      { id: "f1", value: "87" },
      { id: "f2", value: "true" },
    ]);
  });
});
