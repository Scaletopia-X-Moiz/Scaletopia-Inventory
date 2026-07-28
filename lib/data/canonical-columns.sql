-- Run once in the Supabase SQL editor (see docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md).
-- NOTE: on a fresh database, run virtual-columns.sql before this file —
-- company_filter_options below calls virtual_filter_predicate_matches, defined there.
--
-- Adds app-owned "canonical columns" so Postgres can filter, facet, and sort
-- the companies list directly instead of the app re-normalizing all ~87k rows
-- on every request. TypeScript stays the single source of truth for how a raw
-- value becomes canonical (lib/data/country.ts, industry.ts, source.ts) —
-- these columns are a cache of that output, written only by the import
-- pipeline (lib/import/push.ts, lib/import/migrations.sql) and the one-time
-- backfill (lib/import/backfill-canonical-columns.ts). If a column disagrees
-- with what normalize*() would produce for the current raw value, it's stale.

ALTER TABLE companies ADD COLUMN IF NOT EXISTS country_id text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS industry_id text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS source_tokens text[];

-- Plain CREATE INDEX (not CONCURRENTLY) so this whole file can be pasted and
-- run in one shot from the SQL editor, which wraps a paste in one transaction
-- CONCURRENTLY can't run inside. Trade-off: each statement takes a brief
-- write lock on companies instead of none — on ~87k rows that's on the order
-- of seconds, which is fine for a one-time manual migration (same trade-off
-- performance-indexes.sql calls out as the CONCURRENTLY alternative).
CREATE INDEX IF NOT EXISTS companies_country_id_idx
  ON companies (country_id);

CREATE INDEX IF NOT EXISTS companies_industry_id_idx
  ON companies (industry_id);

CREATE INDEX IF NOT EXISTS companies_source_tokens_gin_idx
  ON companies USING gin (source_tokens);

-- Composite sort index backing the DB-side list query's
-- `ORDER BY last_updated DESC, id`. performance-indexes.sql's single-column
-- companies_last_updated index is left in place rather than dropped here —
-- drops belong in a deliberate cleanup, not bundled into a feature migration.
CREATE INDEX IF NOT EXISTS companies_last_updated_id_idx
  ON companies (last_updated DESC, id);

-- RPC: bulk-write country_id/industry_id/source_tokens by id, used only by
-- the one-time backfill (lib/import/backfill-canonical-columns.ts). Unlike
-- import_bulk_update_companies, this unconditionally overwrites (no COALESCE)
-- since the backfill always recomputes fresh from that row's current raw
-- country/industry/source and only enqueues rows that actually changed.
CREATE OR REPLACE FUNCTION backfill_canonical_columns(updates jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  rec jsonb;
BEGIN
  FOR rec IN SELECT * FROM jsonb_array_elements(updates) LOOP
    UPDATE companies SET
      country_id = rec->>'country_id',
      industry_id = rec->>'industry_id',
      source_tokens = ARRAY(SELECT jsonb_array_elements_text(rec->'source_tokens'))
    WHERE id = (rec->>'id')::uuid;
  END LOOP;
END;
$$;

-- RPC: all six /companies facet dimensions in one query. Mirrors
-- getCompanyFilterOptions' in-app semantics exactly: each facet's own count
-- excludes its own filter but is scoped by every other active filter, and the
-- base scan (search / employee size / email+phone presence / virtual-column
-- filters) applies to every facet unconditionally. `filters` is a
-- JSON-serialized CompanyListFilters (see lib/data/companies.ts
-- toFilterOptionsRpcPayload) — include/exclude id lists come straight from
-- the client, already canonical, so no alias table is needed here; only
-- ids/counts are returned, labels are attached back in TS
-- (sourceLabel/industryLabel/countryLabel) so the alias/label tables stay
-- single-edit-point in TypeScript. `virtualFilters` (ticket #33, see
-- virtual-columns.sql) is folded into the same base scan via an inlined
-- `NOT EXISTS (... virtual_filter_predicate_matches ...)` (ticket #37 perf
-- fix — calling through the `virtual_filters_match` wrapper here timed out at
-- scale, same non-inlinable-SubLink issue documented in virtual-columns.sql
-- next to `companies_matching_virtual_filters`), so facet counts share the
-- exact predicate the list/export/push seam uses — never a second,
-- independently-maintained copy.
CREATE OR REPLACE FUNCTION company_filter_options(filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH params AS (
  SELECT
    NULLIF(trim(both from (filters->>'search')), '') AS search,
    (filters->>'employeeMin')::int AS emp_min,
    (filters->>'employeeMax')::int AS emp_max,
    COALESCE(filters->'employeeBucketRanges', '[]'::jsonb) AS emp_ranges,
    COALESCE(filters->>'email', 'any') AS email_filter,
    COALESCE(filters->>'phone', 'any') AS phone_filter,
    COALESCE(filters->'virtualFilters', '[]'::jsonb) AS virtual_filters,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{niche,include}', '[]'::jsonb))) AS niche_inc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{niche,exclude}', '[]'::jsonb))) AS niche_exc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{source,include}', '[]'::jsonb))) AS source_inc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{source,exclude}', '[]'::jsonb))) AS source_exc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{industry,include}', '[]'::jsonb))) AS industry_inc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{industry,exclude}', '[]'::jsonb))) AS industry_exc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{country,include}', '[]'::jsonb))) AS country_inc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{country,exclude}', '[]'::jsonb))) AS country_exc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{emailStatus,include}', '[]'::jsonb))) AS emailstatus_inc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{emailStatus,exclude}', '[]'::jsonb))) AS emailstatus_exc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{phoneType,include}', '[]'::jsonb))) AS phonetype_inc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{phoneType,exclude}', '[]'::jsonb))) AS phonetype_exc
),
-- MATERIALIZED forces one scan of `companies`, reused by all six facet
-- subqueries below instead of six independent scans.
base AS MATERIALIZED (
  SELECT c.niche, c.industry_id, c.country_id, c.source_tokens, c.email_status, c.phone_type
  FROM companies c, params p
  WHERE
    (p.search IS NULL OR c.company_name ILIKE '%' || p.search || '%' OR c.domain ILIKE '%' || p.search || '%')
    AND (
      CASE
        WHEN p.emp_min IS NOT NULL OR p.emp_max IS NOT NULL THEN
          (p.emp_min IS NULL OR c.employee_count >= p.emp_min)
          AND (p.emp_max IS NULL OR c.employee_count <= p.emp_max)
        WHEN jsonb_array_length(p.emp_ranges) > 0 THEN
          EXISTS (
            SELECT 1 FROM jsonb_to_recordset(p.emp_ranges) AS r(min_v int, max_v int)
            WHERE c.employee_count >= r.min_v AND (r.max_v IS NULL OR c.employee_count <= r.max_v)
          )
        ELSE true
      END
    )
    AND (p.email_filter = 'any'
      OR (p.email_filter = 'not_empty' AND c.email IS NOT NULL AND c.email <> '')
      OR (p.email_filter = 'empty' AND (c.email IS NULL OR c.email = '')))
    AND (p.phone_filter = 'any'
      OR (p.phone_filter = 'not_empty' AND c.phone IS NOT NULL AND c.phone <> '')
      OR (p.phone_filter = 'empty' AND (c.phone IS NULL OR c.phone = '')))
    AND (jsonb_array_length(p.virtual_filters) = 0 OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p.virtual_filters) AS vf
      WHERE NOT virtual_filter_predicate_matches(c.custom_data, vf)
    ))
),
niches AS (
  SELECT base.niche AS id, count(*) AS count FROM base, params
  WHERE base.niche IS NOT NULL AND base.niche <> ''
    AND (cardinality(params.country_exc) = 0 OR base.country_id IS NULL OR NOT (base.country_id = ANY(params.country_exc)))
    AND (cardinality(params.country_inc) = 0 OR base.country_id = ANY(params.country_inc))
    AND (cardinality(params.industry_exc) = 0 OR base.industry_id IS NULL OR NOT (base.industry_id = ANY(params.industry_exc)))
    AND (cardinality(params.industry_inc) = 0 OR base.industry_id = ANY(params.industry_inc))
    AND (cardinality(params.source_exc) = 0 OR base.source_tokens IS NULL OR NOT (base.source_tokens && params.source_exc))
    AND (cardinality(params.source_inc) = 0 OR (base.source_tokens IS NOT NULL AND base.source_tokens && params.source_inc))
    AND (cardinality(params.emailstatus_exc) = 0 OR base.email_status IS NULL OR NOT (base.email_status = ANY(params.emailstatus_exc)))
    AND (cardinality(params.emailstatus_inc) = 0 OR base.email_status = ANY(params.emailstatus_inc))
    AND (cardinality(params.phonetype_exc) = 0 OR base.phone_type IS NULL OR NOT (base.phone_type = ANY(params.phonetype_exc)))
    AND (cardinality(params.phonetype_inc) = 0 OR base.phone_type = ANY(params.phonetype_inc))
  GROUP BY base.niche
),
sources AS (
  SELECT token AS id, count(*) AS count FROM (
    SELECT unnest(base.source_tokens) AS token
    FROM base, params
    WHERE (cardinality(params.niche_exc) = 0 OR base.niche IS NULL OR NOT (base.niche = ANY(params.niche_exc)))
      AND (cardinality(params.niche_inc) = 0 OR base.niche = ANY(params.niche_inc))
      AND (cardinality(params.country_exc) = 0 OR base.country_id IS NULL OR NOT (base.country_id = ANY(params.country_exc)))
      AND (cardinality(params.country_inc) = 0 OR base.country_id = ANY(params.country_inc))
      AND (cardinality(params.industry_exc) = 0 OR base.industry_id IS NULL OR NOT (base.industry_id = ANY(params.industry_exc)))
      AND (cardinality(params.industry_inc) = 0 OR base.industry_id = ANY(params.industry_inc))
      AND (cardinality(params.emailstatus_exc) = 0 OR base.email_status IS NULL OR NOT (base.email_status = ANY(params.emailstatus_exc)))
      AND (cardinality(params.emailstatus_inc) = 0 OR base.email_status = ANY(params.emailstatus_inc))
      AND (cardinality(params.phonetype_exc) = 0 OR base.phone_type IS NULL OR NOT (base.phone_type = ANY(params.phonetype_exc)))
      AND (cardinality(params.phonetype_inc) = 0 OR base.phone_type = ANY(params.phonetype_inc))
  ) t
  GROUP BY token
),
industries AS (
  SELECT base.industry_id AS id, count(*) AS count FROM base, params
  WHERE base.industry_id IS NOT NULL
    AND (cardinality(params.niche_exc) = 0 OR base.niche IS NULL OR NOT (base.niche = ANY(params.niche_exc)))
    AND (cardinality(params.niche_inc) = 0 OR base.niche = ANY(params.niche_inc))
    AND (cardinality(params.country_exc) = 0 OR base.country_id IS NULL OR NOT (base.country_id = ANY(params.country_exc)))
    AND (cardinality(params.country_inc) = 0 OR base.country_id = ANY(params.country_inc))
    AND (cardinality(params.source_exc) = 0 OR base.source_tokens IS NULL OR NOT (base.source_tokens && params.source_exc))
    AND (cardinality(params.source_inc) = 0 OR (base.source_tokens IS NOT NULL AND base.source_tokens && params.source_inc))
    AND (cardinality(params.emailstatus_exc) = 0 OR base.email_status IS NULL OR NOT (base.email_status = ANY(params.emailstatus_exc)))
    AND (cardinality(params.emailstatus_inc) = 0 OR base.email_status = ANY(params.emailstatus_inc))
    AND (cardinality(params.phonetype_exc) = 0 OR base.phone_type IS NULL OR NOT (base.phone_type = ANY(params.phonetype_exc)))
    AND (cardinality(params.phonetype_inc) = 0 OR base.phone_type = ANY(params.phonetype_inc))
  GROUP BY base.industry_id
),
countries AS (
  SELECT base.country_id AS id, count(*) AS count FROM base, params
  WHERE base.country_id IS NOT NULL
    AND (cardinality(params.niche_exc) = 0 OR base.niche IS NULL OR NOT (base.niche = ANY(params.niche_exc)))
    AND (cardinality(params.niche_inc) = 0 OR base.niche = ANY(params.niche_inc))
    AND (cardinality(params.industry_exc) = 0 OR base.industry_id IS NULL OR NOT (base.industry_id = ANY(params.industry_exc)))
    AND (cardinality(params.industry_inc) = 0 OR base.industry_id = ANY(params.industry_inc))
    AND (cardinality(params.source_exc) = 0 OR base.source_tokens IS NULL OR NOT (base.source_tokens && params.source_exc))
    AND (cardinality(params.source_inc) = 0 OR (base.source_tokens IS NOT NULL AND base.source_tokens && params.source_inc))
    AND (cardinality(params.emailstatus_exc) = 0 OR base.email_status IS NULL OR NOT (base.email_status = ANY(params.emailstatus_exc)))
    AND (cardinality(params.emailstatus_inc) = 0 OR base.email_status = ANY(params.emailstatus_inc))
    AND (cardinality(params.phonetype_exc) = 0 OR base.phone_type IS NULL OR NOT (base.phone_type = ANY(params.phonetype_exc)))
    AND (cardinality(params.phonetype_inc) = 0 OR base.phone_type = ANY(params.phonetype_inc))
  GROUP BY base.country_id
),
email_statuses AS (
  SELECT base.email_status AS id, count(*) AS count FROM base, params
  WHERE base.email_status IS NOT NULL AND base.email_status <> ''
    AND (cardinality(params.niche_exc) = 0 OR base.niche IS NULL OR NOT (base.niche = ANY(params.niche_exc)))
    AND (cardinality(params.niche_inc) = 0 OR base.niche = ANY(params.niche_inc))
    AND (cardinality(params.country_exc) = 0 OR base.country_id IS NULL OR NOT (base.country_id = ANY(params.country_exc)))
    AND (cardinality(params.country_inc) = 0 OR base.country_id = ANY(params.country_inc))
    AND (cardinality(params.industry_exc) = 0 OR base.industry_id IS NULL OR NOT (base.industry_id = ANY(params.industry_exc)))
    AND (cardinality(params.industry_inc) = 0 OR base.industry_id = ANY(params.industry_inc))
    AND (cardinality(params.source_exc) = 0 OR base.source_tokens IS NULL OR NOT (base.source_tokens && params.source_exc))
    AND (cardinality(params.source_inc) = 0 OR (base.source_tokens IS NOT NULL AND base.source_tokens && params.source_inc))
    AND (cardinality(params.phonetype_exc) = 0 OR base.phone_type IS NULL OR NOT (base.phone_type = ANY(params.phonetype_exc)))
    AND (cardinality(params.phonetype_inc) = 0 OR base.phone_type = ANY(params.phonetype_inc))
  GROUP BY base.email_status
),
phone_types AS (
  SELECT base.phone_type AS id, count(*) AS count FROM base, params
  WHERE base.phone_type IS NOT NULL AND base.phone_type <> ''
    AND (cardinality(params.niche_exc) = 0 OR base.niche IS NULL OR NOT (base.niche = ANY(params.niche_exc)))
    AND (cardinality(params.niche_inc) = 0 OR base.niche = ANY(params.niche_inc))
    AND (cardinality(params.country_exc) = 0 OR base.country_id IS NULL OR NOT (base.country_id = ANY(params.country_exc)))
    AND (cardinality(params.country_inc) = 0 OR base.country_id = ANY(params.country_inc))
    AND (cardinality(params.industry_exc) = 0 OR base.industry_id IS NULL OR NOT (base.industry_id = ANY(params.industry_exc)))
    AND (cardinality(params.industry_inc) = 0 OR base.industry_id = ANY(params.industry_inc))
    AND (cardinality(params.source_exc) = 0 OR base.source_tokens IS NULL OR NOT (base.source_tokens && params.source_exc))
    AND (cardinality(params.source_inc) = 0 OR (base.source_tokens IS NOT NULL AND base.source_tokens && params.source_inc))
    AND (cardinality(params.emailstatus_exc) = 0 OR base.email_status IS NULL OR NOT (base.email_status = ANY(params.emailstatus_exc)))
    AND (cardinality(params.emailstatus_inc) = 0 OR base.email_status = ANY(params.emailstatus_inc))
  GROUP BY base.phone_type
)
SELECT jsonb_build_object(
  'niches', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM niches), '[]'::jsonb),
  'sources', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM sources), '[]'::jsonb),
  'industries', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM industries), '[]'::jsonb),
  'countries', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM countries), '[]'::jsonb),
  'emailStatuses', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM email_statuses), '[]'::jsonb),
  'phoneTypes', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM phone_types), '[]'::jsonb)
);
$$;
