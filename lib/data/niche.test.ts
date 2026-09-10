import { describe, expect, it } from "vitest";
import { nichesFromTags } from "@/lib/data/niche";

const knownClients = new Set(["kynship", "acme"]);

describe("nichesFromTags", () => {
  it("returns empty for missing or empty tags", () => {
    expect(nichesFromTags(null, knownClients)).toEqual([]);
    expect(nichesFromTags(undefined, knownClients)).toEqual([]);
    expect(nichesFromTags([], knownClients)).toEqual([]);
  });

  it("uses a keyed niche: tag directly when present", () => {
    const tags = [
      "niche:marketing-agencies",
      "source:apollo",
      "geo:us",
      "imported:2026-04",
      "campaign:scaletopia-marketing-agencies-2026-04",
    ];
    expect(nichesFromTags(tags, knownClients)).toEqual(["marketing-agencies"]);
  });

  it("strips dates and known client names from flat tags, leaving niche", () => {
    const tags = ["kynship", "dtc-beauty", "2026-06-01"];
    expect(nichesFromTags(tags, knownClients)).toEqual(["dtc-beauty"]);
  });

  it("supports multiple niches when a record was pulled for several campaigns", () => {
    const tags = ["kynship", "dtc-beauty", "2026-04-07", "health-wellness", "2026-06-01"];
    expect(nichesFromTags(tags, knownClients)).toEqual(["dtc-beauty", "health-wellness"]);
  });

  it("strips bare year and year-month date tags, not just full ISO dates", () => {
    // The import Tag Metadata tuple's date element is often a bare year, and its
    // client element ("All clients") only strips because a company carries that
    // client name — mirror that here by seeding it into knownClients.
    const clients = new Set([...knownClients, "all clients"]);
    expect(nichesFromTags(["All clients", "Beauty & Skincare", "2026"], clients)).toEqual([
      "Beauty & Skincare",
    ]);
    expect(nichesFromTags(["kynship", "dtc-beauty", "2026-04"], clients)).toEqual(["dtc-beauty"]);
  });

  it("dedupes repeated niche values", () => {
    const tags = ["kynship", "dtc-beauty", "2026-04-07", "dtc-beauty", "2026-06-01"];
    expect(nichesFromTags(tags, knownClients)).toEqual(["dtc-beauty"]);
  });
});
