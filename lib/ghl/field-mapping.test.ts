import { describe, expect, it } from "vitest";
import { normalizeGhlFieldMapping, normalizeSavedGhlCustomFieldMapping } from "@/lib/ghl/field-mapping";

describe("normalizeGhlFieldMapping", () => {
  it("upgrades a legacy {virtualColumnKey, ghlFieldId} entry to the current column shape", () => {
    const result = normalizeGhlFieldMapping([{ virtualColumnKey: "lead_score", ghlFieldId: "f1" }]);
    expect(result).toEqual([{ ghlFieldId: "f1", source: "column", columnKey: "lead_score" }]);
  });

  it("passes a current-shaped column entry through untouched", () => {
    const entry = { ghlFieldId: "f1", source: "column" as const, columnKey: "lead_score" };
    expect(normalizeGhlFieldMapping([entry])).toEqual([entry]);
  });

  it("passes a current-shaped literal entry through untouched", () => {
    const entry = { ghlFieldId: "f2", source: "literal" as const, value: "static-value" };
    expect(normalizeGhlFieldMapping([entry])).toEqual([entry]);
  });

  it("drops malformed entries rather than throwing", () => {
    const result = normalizeGhlFieldMapping([
      { ghlFieldId: "f1" }, // no source
      { ghlFieldId: "f2", source: "literal" }, // literal missing value
      { ghlFieldId: "f3", source: "column" }, // column missing columnKey
      null,
      "garbage",
      42,
    ]);
    expect(result).toEqual([]);
  });

  it("returns an empty array for a non-array input", () => {
    expect(normalizeGhlFieldMapping(undefined)).toEqual([]);
    expect(normalizeGhlFieldMapping({ virtualColumnKey: "x", ghlFieldId: "f1" })).toEqual([]);
  });

  it("upgrades a mixed array of legacy and current entries", () => {
    const result = normalizeGhlFieldMapping([
      { virtualColumnKey: "lead_score", ghlFieldId: "f1" },
      { ghlFieldId: "f2", source: "literal", value: "static" },
    ]);
    expect(result).toEqual([
      { ghlFieldId: "f1", source: "column", columnKey: "lead_score" },
      { ghlFieldId: "f2", source: "literal", value: "static" },
    ]);
  });
});

describe("normalizeSavedGhlCustomFieldMapping", () => {
  it("upgrades a legacy Record<ghlFieldId, virtualColumnKey string>", () => {
    const result = normalizeSavedGhlCustomFieldMapping({ f1: "lead_score", f2: "plan" });
    expect(result).toEqual({
      f1: { source: "column", columnKey: "lead_score" },
      f2: { source: "column", columnKey: "plan" },
    });
  });

  it("passes a current-shaped Record through untouched", () => {
    const saved = {
      f1: { source: "column", columnKey: "lead_score" },
      f2: { source: "literal", value: "static" },
    };
    expect(normalizeSavedGhlCustomFieldMapping(saved)).toEqual(saved);
  });

  it("drops a garbage entry rather than spreading it into the result", () => {
    const result = normalizeSavedGhlCustomFieldMapping({
      f1: "lead_score",
      f2: 42,
      f3: { source: "literal" }, // missing value
      f4: null,
    });
    expect(result).toEqual({ f1: { source: "column", columnKey: "lead_score" } });
  });

  it("returns an empty object for non-object input", () => {
    expect(normalizeSavedGhlCustomFieldMapping(null)).toEqual({});
    expect(normalizeSavedGhlCustomFieldMapping(undefined)).toEqual({});
    expect(normalizeSavedGhlCustomFieldMapping("garbage")).toEqual({});
  });
});
