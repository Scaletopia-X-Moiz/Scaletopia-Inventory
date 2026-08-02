import { describe, expect, it } from "vitest";
import { countryLabel, normalizeCountry } from "@/lib/data/country";

describe("normalizeCountry", () => {
  it("collapses US synonyms and casing variants", () => {
    expect(normalizeCountry("US")).toEqual({ id: "US", label: "United States" });
    expect(normalizeCountry("United States")).toEqual({ id: "US", label: "United States" });
    expect(normalizeCountry("united states")).toEqual({ id: "US", label: "United States" });
  });

  it("collapses UK synonyms", () => {
    expect(normalizeCountry("GB")).toEqual({ id: "GB", label: "United Kingdom" });
    expect(normalizeCountry("United Kingdom")).toEqual({ id: "GB", label: "United Kingdom" });
  });

  it("collapses Canada synonyms", () => {
    expect(normalizeCountry("CA")).toEqual({ id: "CA", label: "Canada" });
    expect(normalizeCountry("canada")).toEqual({ id: "CA", label: "Canada" });
  });

  it("title-cases unknown countries without an alias", () => {
    expect(normalizeCountry("spain")).toEqual({ id: "SPAIN", label: "Spain" });
  });

  it("resolves ISO-3166 alpha-2 codes without a hardcoded alias to full names", () => {
    expect(normalizeCountry("IN")).toEqual({ id: "IN", label: "India" });
    expect(normalizeCountry("au")).toEqual({ id: "AU", label: "Australia" });
    expect(normalizeCountry("de")).toEqual({ id: "DE", label: "Germany" });
    expect(normalizeCountry("nl")).toEqual({ id: "NL", label: "Netherlands" });
  });

  it("returns null for empty/null/undefined", () => {
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry(undefined)).toBeNull();
    expect(normalizeCountry("  ")).toBeNull();
  });
});

describe("countryLabel", () => {
  it("uses the fixed alias label for US/UK/Canada ids", () => {
    expect(countryLabel("US")).toBe("United States");
    expect(countryLabel("GB")).toBe("United Kingdom");
    expect(countryLabel("CA")).toBe("Canada");
  });

  it("resolves other ISO-3166 alpha-2 ids to full names (not a 2-letter code)", () => {
    expect(countryLabel("IN")).toBe("India");
    expect(countryLabel("AU")).toBe("Australia");
    expect(countryLabel("DE")).toBe("Germany");
    expect(countryLabel("NL")).toBe("Netherlands");
  });
});
