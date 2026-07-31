import { describe, expect, it } from "vitest";
import { buildEmailBisonLeadPayload } from "@/lib/emailbison/lead-payload";

const fullRecord = {
  firstName: "Jane",
  lastName: "Doe",
  email: "jane@example.com",
  phone: "+15551234567",
  companyName: "Acme Inc",
  title: "VP Sales",
  website: "acme.com",
};

describe("buildEmailBisonLeadPayload", () => {
  it("shapes a full record into an EmailBison lead payload", () => {
    expect(buildEmailBisonLeadPayload(fullRecord)).toEqual({
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
    const record = {
      firstName: null,
      lastName: null,
      email: null,
      phone: null,
      companyName: null,
      title: null,
      website: null,
    };
    expect(buildEmailBisonLeadPayload(record)).toEqual({
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
    const result = buildEmailBisonLeadPayload(fullRecord);
    expect(result.existingLeadBehavior).toBe("patch");
  });

  it("applies an explicit existingLeadBehavior of put", () => {
    const result = buildEmailBisonLeadPayload(fullRecord, [], "put");
    expect(result.existingLeadBehavior).toBe("put");
  });

  it("carries selected custom-variable entries through as name/value pairs", () => {
    const customVariables = [
      { name: "lead_score", value: "87" },
      { name: "plan", value: "pro" },
    ];
    const result = buildEmailBisonLeadPayload(fullRecord, customVariables);
    expect(result.customVariables).toEqual(customVariables);
  });

  it("defaults customVariables to an empty array when omitted", () => {
    const result = buildEmailBisonLeadPayload(fullRecord);
    expect(result.customVariables).toEqual([]);
  });

  it("supports zero custom-variable entries", () => {
    const result = buildEmailBisonLeadPayload(fullRecord, []);
    expect(result.customVariables).toEqual([]);
  });
});
