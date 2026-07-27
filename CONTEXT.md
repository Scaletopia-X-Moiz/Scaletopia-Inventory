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

### Enrichment field
A key inside the `custom_data` JSONB, campaign-specific and different for every
campaign (e.g. `lead_score`, `specialties`, `qualificationStatus`). Distinct
from a **canonical column**: enrichment fields are raw, unnormalized, and never
promoted to a real database column.
_Avoid_: custom field (that means a GHL field), attribute.

### Virtual column
A view-only column over one **enrichment field**, added to the Companies or
People table on demand. It exists only in the interface state — never in the
Supabase schema, and `custom_data` is never modified. Its purpose is to let the
user **filter** the full result set on an enrichment field, then export or push
the narrowed set. Removed from view (not from data) after a push/export.
_Avoid_: computed column, derived column.

### Filterable type
The interpretation a virtual column applies to an enrichment field's values,
which selects the operator set and the SQL shape: **Text / Number / Boolean /
List / Date**. Because the same key can hold different shapes across rows, the
type is **inferred by sampling** the dominant shape and is user-overridable — it
is a property of the key *most of the time*, not a schema fact.

### Empty (enrichment value)
For filtering purposes, an enrichment value counts as empty when it is `null`,
`""`, whitespace-only, an empty array, the sentinel `"-"`, or an **unrendered
Clay template** (`"{{ ... }}"`). "is empty" / "is not empty" operators and the
value picker all use this normalized definition, so placeholder junk never reads
as real data.
