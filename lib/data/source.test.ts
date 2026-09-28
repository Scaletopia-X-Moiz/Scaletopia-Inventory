import { describe, expect, it } from "vitest";
import { normalizeSourceTokens, sourceLabel } from "@/lib/data/source";
import { BUILTIN_PROVIDERS, CANONICAL_SOURCE_KEYS } from "@/lib/import/providers";

describe("normalizeSourceTokens", () => {
  it("splits on comma (companies format)", () => {
    expect(normalizeSourceTokens("aiark-api,blitz-api")).toEqual(["aiark", "blitz"]);
  });

  it("splits on ampersand (people format)", () => {
    expect(normalizeSourceTokens("blitz & Ai Ark")).toEqual(["blitz", "aiark"]);
  });

  it("collapses provider aliases across both tables into one canonical token", () => {
    expect(normalizeSourceTokens("aiark-api")).toEqual(["aiark"]);
    expect(normalizeSourceTokens("aiark-people")).toEqual(["aiark"]);
    expect(normalizeSourceTokens("Ai Ark")).toEqual(["aiark"]);
  });

  it("dedupes repeated tokens within one value", () => {
    expect(normalizeSourceTokens("aiark-api,aiark-api,blitz-api")).toEqual(["aiark", "blitz"]);
  });

  it("keeps distinct apollo variants separate", () => {
    expect(normalizeSourceTokens("apollo")).toEqual(["apollo"]);
    expect(normalizeSourceTokens("apollo-scraped")).toEqual(["apollo-scraped"]);
  });

  it("returns an empty array for null/empty input", () => {
    expect(normalizeSourceTokens(null)).toEqual([]);
    expect(normalizeSourceTokens("")).toEqual([]);
  });

  it("keeps the quickenrich import key as its own canonical token", () => {
    expect(normalizeSourceTokens("quickenrich")).toEqual(["quickenrich"]);
    expect(normalizeSourceTokens("QuickEnrich")).toEqual(["quickenrich"]);
    expect(normalizeSourceTokens("quickenrich & aiark-people")).toEqual(["quickenrich", "aiark"]);
  });
});

describe("sourceLabel", () => {
  it("labels quickenrich with the product's own casing", () => {
    expect(sourceLabel("quickenrich")).toBe("QuickEnrich");
  });

  it("the quickenrich import preset writes a source that chips and filters label correctly", () => {
    const preset = BUILTIN_PROVIDERS.find((p) => p.sourceKey === "quickenrich");
    expect(preset?.displayName).toBe("QuickEnrich");
    expect(CANONICAL_SOURCE_KEYS).toContain("quickenrich");
    const tokens = normalizeSourceTokens(preset!.sourceKey);
    expect(tokens.map(sourceLabel)).toEqual([preset!.displayName]);
  });
});
