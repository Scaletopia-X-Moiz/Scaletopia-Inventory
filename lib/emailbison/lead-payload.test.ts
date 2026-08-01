import { describe, expect, it } from "vitest";
import { buildEmailBisonLeadPayload, resolveCustomVariables } from "@/lib/emailbison/lead-payload";

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

describe("resolveCustomVariables", () => {
  const customData = { lead_score: 87, is_decision_maker: true, tags: ["a", "b"], empty: null };

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

  it("resolves a column-bound entry from custom_data (virtual column)", () => {
    const entries = [{ name: "score", value: "", columnKey: "lead_score" }];
    expect(resolveCustomVariables(entries, fullRecord, customData)).toEqual([
      { name: "score", value: "87" },
    ]);
  });

  it("stringifies booleans, numbers, and arrays from custom_data", () => {
    const entries = [
      { name: "dm", value: "", columnKey: "is_decision_maker" },
      { name: "tags", value: "", columnKey: "tags" },
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
