import { humanizeSlug } from "@/lib/utils";

// Raw source tokens, enumerated from live data (see docs/DB-Findings.md):
//   companies (comma-separated): aiark-api, blitz-api, apollo, apollo-scraped, store-leads
//   people (&-separated):        aiark-people, blitz-people, "Ai Ark", "blitz", clay-people
const SOURCE_ALIASES: Record<string, string> = {
  "aiark-api": "aiark",
  "aiark-people": "aiark",
  "ai ark": "aiark",
  "blitz-api": "blitz",
  "blitz-people": "blitz",
  blitz: "blitz",
  apollo: "apollo",
  "apollo-scraped": "apollo-scraped",
  "store-leads": "store-leads",
  "clay-people": "clay",
  // Import source key for QuickEnrich exports (lib/import/providers.ts).
  quickenrich: "quickenrich",
};

const CANONICAL_LABELS: Record<string, string> = {
  aiark: "AI Ark",
  blitz: "Blitz",
  apollo: "Apollo",
  "apollo-scraped": "Apollo (scraped)",
  "store-leads": "Store Leads",
  clay: "Clay",
  quickenrich: "QuickEnrich",
};

/** Splits a raw source string on `,` or `&`, trims, dedupes, and maps each
 * token to its canonical id. Handles both the companies (comma) and people
 * (ampersand) delimiter conventions under one function. */
export function normalizeSourceTokens(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const tokens = raw
    .split(/[,&]/)
    .map((t) => t.trim())
    .filter(Boolean)
    .map((t) => SOURCE_ALIASES[t.toLowerCase()] ?? t.toLowerCase());
  return Array.from(new Set(tokens));
}

export function sourceLabel(canonicalId: string): string {
  return CANONICAL_LABELS[canonicalId] ?? humanizeSlug(canonicalId);
}
