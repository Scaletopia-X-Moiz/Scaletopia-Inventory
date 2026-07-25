// Real data has both genuine synonyms (US vs United States) and bare casing
// variants (Canada vs canada). See docs/DB-Findings.md.
const COUNTRY_ALIASES: Record<string, { id: string; label: string }> = {
  us: { id: "US", label: "United States" },
  usa: { id: "US", label: "United States" },
  "united states": { id: "US", label: "United States" },
  gb: { id: "GB", label: "United Kingdom" },
  uk: { id: "GB", label: "United Kingdom" },
  "united kingdom": { id: "GB", label: "United Kingdom" },
  ca: { id: "CA", label: "Canada" },
  canada: { id: "CA", label: "Canada" },
};

function titleCase(value: string): string {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function normalizeCountry(raw: string | null | undefined): { id: string; label: string } | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  const alias = COUNTRY_ALIASES[trimmed.toLowerCase()];
  if (alias) return alias;
  const id = trimmed.toUpperCase();
  return { id, label: titleCase(trimmed) };
}

const COUNTRY_LABELS_BY_ID: Record<string, string> = Object.fromEntries(
  Object.values(COUNTRY_ALIASES).map((v) => [v.id, v.label])
);

/** Reconstructs a display label from a canonical country_id alone (the DB-side
 * facet RPC returns ids, not the raw row that produced them). Aliased
 * countries (US/GB/CA) use their fixed label; anything else derives a label
 * purely from the id (already uppercase — e.g. "FRANCE" -> "France"), which
 * is deterministic unlike the old per-row `normalizeCountry(...).label`
 * fallback (title-cased from whatever casing that row's raw value happened
 * to use). */
export function countryLabel(id: string): string {
  const known = COUNTRY_LABELS_BY_ID[id];
  if (known) return known;
  return id
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
