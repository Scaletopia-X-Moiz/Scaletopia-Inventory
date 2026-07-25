# 1. DB-side /companies list via app-owned canonical columns

Date: 2026-07-26

## Status

Accepted

## Context

The `/companies` list page is slow: a perceived ~7.3s load. The browser fires
two independent requests in parallel — `/api/companies/results` (the list,
~7.3s) and `/api/companies/filter-options` (the facets, ~5.9s) — and waits for
the slower. Both currently pull the entire ~87k-row `companies` table into app
memory and filter/facet/sort in TypeScript, because the filter values
(`country`, `source`, `industry`) need normalization (alias maps, casing,
delimiter splitting) that only the app knows how to do.

A live prototype (see the `companies-dbside-pagination-finding` note) proved
that doing the sort + limit in Postgres drops the list query to ~0.5s (14.5x)
and a pushable filter to ~0.5s (6.5x). But the win only reaches the *user* if
**both** the list and the facets go DB-side, since they race in parallel — and
neither can go DB-side until Postgres can filter/aggregate on the canonical
(normalized) form of `country`/`source`/`industry`.

## Decision

Persist the canonical form of the three normalized fields as **app-owned plain
columns** and move filtering, faceting, and pagination into Postgres.

- **Canonical columns:** `country_id text`, `industry_id text`,
  `source_tokens text[]` (source is multi-valued — one raw string splits into
  several tokens). Indexed: btree on `country_id`/`industry_id`, GIN on
  `source_tokens`, plus a composite `(last_updated DESC, id)` for the sort.
- **Source of truth stays in TypeScript.** The existing `normalizeCountry`,
  `normalizeIndustry`, `normalizeSourceTokens` functions remain authoritative.
  The columns are a *cache* of their output.
- **Sync:** the import pipeline is the sole writer of these fields. Its preflight
  (which already normalizes per row) computes the canonical values in TS and
  includes them in the bulk-update RPC and insert payloads; the RPC/insert just
  store them. A one-time TS backfill script populates existing rows using the
  same functions. A guard test asserts a fresh import sets the columns.
- **List query:** offset + limit with page numbers (`?page=N`) preserved, sorted
  in Postgres, with all cleanly-pushable filters (country/industry/source/niche/
  employee/search/email+phone presence/status) in the `WHERE` clause. Exact
  `count(*)` for the total.
- **Facets:** a single RPC returns all six facet dimensions, each preserving
  today's exclude-own-filter / scoped-by-others semantics exactly.

## Consequences

- Perceived `/companies` load target ~7.3s → ~0.5s (both parallel requests
  DB-side). Measured for the list + pushable filter; facet RPC estimated.
- Deep pages (offset ~1000+, i.e. page 1000 of 1740) degrade gradually as OFFSET
  discards preceding rows — accepted because real users don't page that deep,
  and it keeps the jump-to-any-page UI with zero frontend changes.
- **Rejected — DB trigger / generated columns** that recompute canonical values
  in SQL. It would cover any writer automatically, but duplicates the alias maps
  into SQL: adding one new source alias would then require editing both
  `source.ts` and a SQL table, and forgetting the SQL side silently misfiles
  rows into the wrong facet with no error. We keep a single edit point (TS) at
  the cost of relying on import staying the sole writer (guarded by a test).
- **Rejected — keyset cursor pagination.** Every page would be ~0.5s regardless
  of depth, but it removes jump-to-page-N (next/prev only) and forces an API +
  pagination-component rewrite — work spent on depth users don't reach.
- **Rejected — inline normalization in an RPC** (no stored columns). Re-normalizing
  87k rows per query can't use an index, so it wouldn't hit the facet target.
- New coupling: any *future* non-import writer of `country`/`source`/`industry`
  must also populate the canonical columns, or they go stale. The guard test and
  this ADR are the mitigations.
