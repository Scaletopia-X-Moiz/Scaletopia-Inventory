import { describe, expect, it } from "vitest";
import { buildGhlContactPayload } from "@/lib/ghl/contact-payload";

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
});
