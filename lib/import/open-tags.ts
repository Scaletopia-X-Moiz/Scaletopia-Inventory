/** Open (GHL-style) tags: free-form, optional, merged into a record's
 * `open_tags` on import (never overwritten). Shared by the wizard UI, the
 * /api/import-jobs route and tests. */
export const MAX_OPEN_TAG_LENGTH = 100;
export const MAX_OPEN_TAGS = 50;

/** Trims, drops empties, caps each tag's length, dedupes case-insensitively
 * (first spelling wins) and caps the total. Non-strings are ignored. */
export function normalizeOpenTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of input) {
    if (typeof raw !== "string") continue;
    const tag = raw.trim().replace(/\s+/g, " ").slice(0, MAX_OPEN_TAG_LENGTH).trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
    if (out.length >= MAX_OPEN_TAGS) break;
  }
  return out;
}

/** True when `input` is an array whose every element is a string. */
export function isStringArray(input: unknown): input is string[] {
  return Array.isArray(input) && input.every((t) => typeof t === "string");
}
