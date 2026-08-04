import { describe, expect, it } from "vitest";
import { EMPLOYEE_BUCKETS } from "@/lib/data/employee-size";
import { buildGhlTag } from "@/lib/ghl/tag";

const bucketLabel = (id: string): string =>
  EMPLOYEE_BUCKETS.find((b) => b.id === id)!.label;

describe("buildGhlTag", () => {
  it("builds the full structured tag when every field is present", () => {
    const tag = buildGhlTag("Acme", {
      niche: "dtc-beauty",
      employeeCount: 35,
      country: "US",
      source: "apollo",
    });
    expect(tag).toBe(`Acme - dtc-beauty | ${bucketLabel("11-50")} | US | apollo`);
  });

  it.each([
    [1, "1-10"],
    [10, "1-10"],
    [11, "11-50"],
    [50, "11-50"],
    [51, "51-200"],
    [200, "51-200"],
    [201, "201-500"],
    [500, "201-500"],
    [501, "500+"],
    [10_000, "500+"],
  ])("buckets an employee count of %i into the %s range", (count, bucketId) => {
    const tag = buildGhlTag("Acme", {
      niche: "n",
      employeeCount: count,
      country: "US",
      source: "apollo",
    });
    expect(tag).toBe(`Acme - n | ${bucketLabel(bucketId)} | US | apollo`);
  });

  it("falls back to Unknown for a missing niche", () => {
    const tag = buildGhlTag("Acme", {
      niche: null,
      employeeCount: 5,
      country: "US",
      source: "apollo",
    });
    expect(tag).toBe(`Acme - Unknown | ${bucketLabel("1-10")} | US | apollo`);
  });

  it("falls back to Unknown for a missing country", () => {
    const tag = buildGhlTag("Acme", {
      niche: "n",
      employeeCount: 5,
      country: null,
      source: "apollo",
    });
    expect(tag).toBe(`Acme - n | ${bucketLabel("1-10")} | Unknown | apollo`);
  });

  it("falls back to Unknown for a missing source", () => {
    const tag = buildGhlTag("Acme", {
      niche: "n",
      employeeCount: 5,
      country: "US",
      source: null,
    });
    expect(tag).toBe(`Acme - n | ${bucketLabel("1-10")} | US | Unknown`);
  });

  it("falls back to Unknown for a missing or out-of-range employee count", () => {
    expect(
      buildGhlTag("Acme", { niche: "n", employeeCount: null, country: "US", source: "apollo" })
    ).toBe("Acme - n | Unknown | US | apollo");
    expect(
      buildGhlTag("Acme", { niche: "n", employeeCount: 0, country: "US", source: "apollo" })
    ).toBe("Acme - n | Unknown | US | apollo");
  });

  it("treats blank strings the same as missing values", () => {
    const tag = buildGhlTag("Acme", {
      niche: "  ",
      employeeCount: 5,
      country: "",
      source: "   ",
    });
    expect(tag).toBe(`Acme - Unknown | ${bucketLabel("1-10")} | Unknown | Unknown`);
  });

  it("appends a custom suffix as an extra pipe-delimited segment", () => {
    const tag = buildGhlTag(
      "Acme",
      { niche: "dtc-beauty", employeeCount: 35, country: "US", source: "apollo" },
      "leadership"
    );
    expect(tag).toBe(`Acme - dtc-beauty | ${bucketLabel("11-50")} | US | apollo | leadership`);
  });

  it("trims whitespace around the custom suffix", () => {
    const tag = buildGhlTag(
      "Acme",
      { niche: "n", employeeCount: 5, country: "US", source: "apollo" },
      "  marketing  "
    );
    expect(tag).toBe(`Acme - n | ${bucketLabel("1-10")} | US | apollo | marketing`);
  });

  it("omits the suffix segment when the custom suffix is missing, null, or blank", () => {
    const base = `Acme - n | ${bucketLabel("1-10")} | US | apollo`;
    expect(
      buildGhlTag("Acme", { niche: "n", employeeCount: 5, country: "US", source: "apollo" })
    ).toBe(base);
    expect(
      buildGhlTag(
        "Acme",
        { niche: "n", employeeCount: 5, country: "US", source: "apollo" },
        null
      )
    ).toBe(base);
    expect(
      buildGhlTag(
        "Acme",
        { niche: "n", employeeCount: 5, country: "US", source: "apollo" },
        "   "
      )
    ).toBe(base);
  });
});
