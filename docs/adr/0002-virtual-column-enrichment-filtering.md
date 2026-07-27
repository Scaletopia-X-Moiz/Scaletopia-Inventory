# Server-side, cast-safe virtual-column filtering over `custom_data`

## Context

Enrichment fields live in `custom_data` JSONB and differ per campaign. Users
add **virtual columns** over these fields to filter the result set, then export
or push the narrowed set. The narrowing must apply to the *whole* table (up to
~87k companies), not the loaded page, so filtering runs **server-side in SQL**.

Real `custom_data` is dirty in ways that break the ticket's naive SQL:
- Same key holds different shapes across rows (`followers`: number in most rows,
  string in a few; `specialties`: array / null / string).
- Numbers stored with units (`Technology Spend` = `"$10"`, growth = `"20%"`).
- Sentinels and unrendered Clay templates (`"-"`, `"{{ 0 }}"`) that are neither
  null nor empty.
- Arrays (`["a3","a4"]`) and ISO-date strings (`"2025-05-05"`) with no clean
  type in the ticket's Text/Number/Boolean model.

The ticket's own example, `(custom_data->>'lead_score')::numeric BETWEEN 90 AND
100`, **500s the entire request** the moment the scan touches one non-numeric
row — which the data guarantees.

## Decision

- **Filtering is server-side SQL** over the full table (correct counts,
  pagination, and export/push of the narrowed set).
- **Five filterable types**: Text / Number / Boolean / **List** / **Date**.
  List uses JSONB containment (`custom_data->'k' ? 'a3'`), not `ILIKE` on the
  serialized array, to avoid false positives. Date compares ISO strings
  lexicographically (correct because `YYYY-MM-DD` sorts as text) — no cast.
- **Every numeric/date comparison is regex-guarded before the cast**
  (`custom_data->>'k' ~ '^-?[0-9.]+$' AND (...)::numeric > 90`). Non-matching
  rows are excluded, never crashed. No `safe_to_numeric` DB function: its
  per-row exception handling is slow on full scans, and the guard needs no
  migration.
- **Type is inferred by sampling** the dominant shape when a column is added,
  and is user-overridable.
- A single scoped RPC discovers keys → inferred type → capped distinct sample
  values (feeding a value picker for low-cardinality text). Key discovery
  **samples** rather than full-scanning `DISTINCT jsonb_object_keys` for
  responsiveness; the filter itself still runs across the full set.
- **`"-"`, whitespace, empty array/string, and `"{{ ... }}"` templates
  normalize to empty** for empty/not-empty operators and the value picker.
- The key picker **reuses the existing display blocklist**
  (`lib/data/custom-data.ts`), so housekeeping keys stay hidden everywhere.

## Consequences

- No schema or `custom_data` writes; virtual columns are URL/interface state.
- A regex guard silently excludes malformed values from Number/Date results —
  correct, but means a filter's result count can be smaller than the raw key
  population. This is intended, not a bug.
- Unit-bearing numbers (`"$10"`, `"20%"`) are excluded by the guard rather than
  parsed. Per-field unit-stripping is a deliberate future follow-on, not a
  general rule, to avoid inventing meaning the data doesn't carry.
