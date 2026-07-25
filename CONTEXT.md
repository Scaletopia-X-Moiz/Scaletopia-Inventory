# Context: Scaletopia Inventory

The ubiquitous language for the data-inventory domain. Terms here are meaningful
to domain experts, not implementation details.

## Glossary

### Canonical value
The normalized, deduplicated form of a raw enrichment field, produced by the
app's `normalize*()` functions (`normalizeCountry`, `normalizeIndustry`,
`normalizeSourceTokens`). Raw data arrives with casing variants, aliases, and
delimiter conventions (e.g. `United States` / `united states` → `US`;
`aiark-api` / `Ai Ark` → `aiark`). The canonical value is what the UI filters,
facets, and groups by. **TypeScript is the single source of truth** for how a
raw value becomes canonical.

### Canonical column
A persisted copy of a canonical value, stored on the row so Postgres can filter
and aggregate on it directly instead of the app re-normalizing every row:
- `country_id` — single canonical country (e.g. `US`)
- `industry_id` — single canonical industry key
- `source_tokens` — `text[]` of canonical source tokens (source is
  **multi-valued**: one raw string splits into several tokens, unlike country
  and industry which are single-valued)

Canonical columns are a cache of the TS `normalize*()` output, written by the
app on every write and backfilled once. They are never the source of truth —
if they disagree with what `normalize*()` would produce, the column is stale.

### Facet
A count of matching rows per canonical value within a filter dimension (niche,
source, industry, country, email status, phone type), shown in the filter UI.
Each facet's own count **excludes its own filter** but is scoped by every other
active filter, so picking one Source value doesn't zero out the other Source
options.
