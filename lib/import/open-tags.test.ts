import { describe, expect, it } from "vitest";
import { MAX_OPEN_TAGS, MAX_OPEN_TAG_LENGTH, isStringArray, normalizeOpenTags } from "./open-tags";

describe("normalizeOpenTags", () => {
  it("trims, collapses whitespace and drops empties", () => {
    expect(normalizeOpenTags(["  a  b ", "", "   "])).toEqual(["a b"]);
  });
  it("dedupes case-insensitively keeping the first spelling", () => {
    expect(normalizeOpenTags(["Foo Bar", "foo bar", "FOO BAR", "x"])).toEqual(["Foo Bar", "x"]);
  });
  it("caps tag length and total count", () => {
    expect(normalizeOpenTags(["a".repeat(150)])[0]).toHaveLength(MAX_OPEN_TAG_LENGTH);
    const many = Array.from({ length: 80 }, (_, i) => `t${i}`);
    expect(normalizeOpenTags(many)).toHaveLength(MAX_OPEN_TAGS);
  });
  it("returns [] for non-arrays and skips non-strings", () => {
    expect(normalizeOpenTags(undefined)).toEqual([]);
    expect(normalizeOpenTags("x")).toEqual([]);
    expect(normalizeOpenTags(["a", 1, null])).toEqual(["a"]);
  });
});

describe("isStringArray", () => {
  it("accepts only arrays of strings", () => {
    expect(isStringArray(["a"])).toBe(true);
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(["a", 1])).toBe(false);
    expect(isStringArray("a")).toBe(false);
  });
});
