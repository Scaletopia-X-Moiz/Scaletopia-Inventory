-- Run once in the Supabase SQL editor (see docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md
-- and the "people" follow-up tickets #20-#25 that extend that same pattern to /people).
-- NOTE: on a fresh database, run virtual-columns.sql before this file —
-- person_filter_options below calls virtual_filter_predicate_matches, defined there.
--
-- Adds app-owned "canonical columns" so Postgres can filter, facet, and sort
-- the people list directly instead of the app re-normalizing/joining against
-- companies on every request. TypeScript stays the single source of truth for
-- how a raw value becomes canonical (lib/data/country.ts, source.ts,
-- lib/data/niche.ts's nichesFromTags) — these columns are a cache of that
-- output, written only by the import pipeline (lib/import/push.ts,
-- lib/import/migrations.sql), the company->people propagation RPC below, and
-- the one-time backfill (lib/import/backfill-canonical-columns-people.ts). If
-- a column disagrees with what those functions would produce for the row's
-- current raw data / linked company, it's stale.

ALTER TABLE people ADD COLUMN IF NOT EXISTS country_id text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS source_tokens text[];
ALTER TABLE people ADD COLUMN IF NOT EXISTS industry_id text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS employee_count int;
ALTER TABLE people ADD COLUMN IF NOT EXISTS company_linkedin_url text;
ALTER TABLE people ADD COLUMN IF NOT EXISTS niche_tokens text[];

-- Plain CREATE INDEX (not CONCURRENTLY) so this whole file can be pasted and
-- run in one shot from the SQL editor, which wraps a paste in one transaction
-- CONCURRENTLY can't run inside — same trade-off canonical-columns.sql makes.
CREATE INDEX IF NOT EXISTS people_country_id_idx
  ON people (country_id);

CREATE INDEX IF NOT EXISTS people_industry_id_idx
  ON people (industry_id);

CREATE INDEX IF NOT EXISTS people_source_tokens_gin_idx
  ON people USING gin (source_tokens);

CREATE INDEX IF NOT EXISTS people_niche_tokens_gin_idx
  ON people USING gin (niche_tokens);

-- Composite sort index backing the DB-side list query's
-- `ORDER BY last_updated DESC, id`, mirroring companies_last_updated_id_idx.
CREATE INDEX IF NOT EXISTS people_last_updated_id_idx
  ON people (last_updated DESC, id);

-- RPC: bulk-write all 6 canonical columns by id, used only by the one-time
-- backfill (lib/import/backfill-canonical-columns-people.ts). Unlike
-- import_bulk_update_people, this unconditionally overwrites (no COALESCE)
-- since the backfill always recomputes fresh from that row's current raw
-- data / linked company and only enqueues rows that actually changed.
CREATE OR REPLACE FUNCTION backfill_canonical_columns_people(updates jsonb)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  rec jsonb;
BEGIN
  FOR rec IN SELECT * FROM jsonb_array_elements(updates) LOOP
    UPDATE people SET
      country_id = rec->>'country_id',
      source_tokens = ARRAY(SELECT jsonb_array_elements_text(rec->'source_tokens')),
      industry_id = rec->>'industry_id',
      employee_count = CASE WHEN rec->>'employee_count' IS NOT NULL THEN (rec->>'employee_count')::int ELSE NULL END,
      company_linkedin_url = rec->>'company_linkedin_url',
      niche_tokens = ARRAY(SELECT jsonb_array_elements_text(rec->'niche_tokens'))
    WHERE id = (rec->>'id')::uuid;
  END LOOP;
END;
$$;

-- RPC: all six /people facet dimensions in one query. Mirrors
-- getPersonFilterOptions' in-app semantics exactly: each facet's own count
-- excludes its own filter but is scoped by every other active filter, and the
-- base scan (search / employee size / email+phone presence / jobTitle /
-- virtual-column filters) applies to every facet unconditionally.
-- `niche_tokens`/`source_tokens` are multi-valued (unnest + GIN), unlike
-- companies' scalar `niche` — a person with 2 niche tokens contributes to
-- both counts. `filters` is a JSON-serialized PersonListFilters (see
-- lib/data/people.ts toFilterOptionsRpcPayload); include/exclude id lists
-- come straight from the client, already canonical, so no alias table is
-- needed here — only ids/counts are returned, labels are attached back in TS.
-- `virtualFilters` (ticket #33, see virtual-columns.sql) is folded into the
-- same base scan via an inlined `NOT EXISTS (... virtual_filter_predicate_matches
-- ...)` (ticket #37 perf fix — same non-inlinable-SubLink timeout as
-- `company_filter_options`, not the `virtual_filters_match` wrapper), sharing
-- the exact predicate the People list/export/push seam uses.
CREATE OR REPLACE FUNCTION person_filter_options(filters jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH params AS (
  SELECT
    NULLIF(trim(both from (filters->>'search')), '') AS search,
    NULLIF(trim(both from (filters->>'jobTitle')), '') AS job_title,
    (filters->>'employeeMin')::int AS emp_min,
    (filters->>'employeeMax')::int AS emp_max,
    COALESCE(filters->'employeeBucketRanges', '[]'::jsonb) AS emp_ranges,
    COALESCE(filters->>'email', 'any') AS email_filter,
    COALESCE(filters->>'phone', 'any') AS phone_filter,
    COALESCE(filters->'virtualFilters', '{}'::jsonb) AS virtual_filters,
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
-- MATERIALIZED forces one scan of `people`, reused by all six facet
-- subqueries below instead of six independent scans.
base AS MATERIALIZED (
  SELECT p.niche_tokens, p.industry_id, p.country_id, p.source_tokens,
         p.employee_count, p.email_status, p.phone_type, p.email, p.phone, p.job_title
  FROM people p, params pr
  WHERE
    (pr.search IS NULL OR p.full_name ILIKE '%' || pr.search || '%' OR p.email ILIKE '%' || pr.search || '%')
    AND (pr.job_title IS NULL OR p.job_title ILIKE '%' || pr.job_title || '%')
    AND (
      CASE
        WHEN pr.emp_min IS NOT NULL OR pr.emp_max IS NOT NULL THEN
          (pr.emp_min IS NULL OR p.employee_count >= pr.emp_min)
          AND (pr.emp_max IS NULL OR p.employee_count <= pr.emp_max)
        WHEN jsonb_array_length(pr.emp_ranges) > 0 THEN
          EXISTS (
            SELECT 1 FROM jsonb_to_recordset(pr.emp_ranges) AS r(min_v int, max_v int)
            WHERE p.employee_count >= r.min_v AND (r.max_v IS NULL OR p.employee_count <= r.max_v)
          )
        ELSE true
      END
    )
    AND (pr.email_filter = 'any'
      OR (pr.email_filter = 'not_empty' AND p.email IS NOT NULL AND p.email <> '')
      OR (pr.email_filter = 'empty' AND (p.email IS NULL OR p.email = '')))
    AND (pr.phone_filter = 'any'
      OR (pr.phone_filter = 'not_empty' AND p.phone IS NOT NULL AND p.phone <> '')
      OR (pr.phone_filter = 'empty' AND (p.phone IS NULL OR p.phone = '')))
    -- Grouped virtual-filter fold (ticket #117) — keep in lockstep with all
    -- six inlined copies (virtual-columns.sql, canonical-columns.sql,
    -- enrichment-fields.sql).
    AND (
      COALESCE(jsonb_array_length(pr.virtual_filters->'groups'), 0) = 0
      OR CASE WHEN COALESCE(pr.virtual_filters->>'combinator', 'and') = 'or' THEN
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(pr.virtual_filters->'groups') AS grp
          WHERE CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
              EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                      WHERE virtual_filter_predicate_matches(p.custom_data, cond))
            ELSE
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                          WHERE NOT virtual_filter_predicate_matches(p.custom_data, cond))
            END
        )
      ELSE
        NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(pr.virtual_filters->'groups') AS grp
          WHERE NOT (CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
              EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                      WHERE virtual_filter_predicate_matches(p.custom_data, cond))
            ELSE
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                          WHERE NOT virtual_filter_predicate_matches(p.custom_data, cond))
            END)
        )
      END
    )
),
niches AS (
  SELECT token AS id, count(*) AS count FROM (
    SELECT unnest(base.niche_tokens) AS token
    FROM base, params
    WHERE base.niche_tokens IS NOT NULL
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
      AND (
        CASE
          WHEN params.emp_min IS NOT NULL OR params.emp_max IS NOT NULL THEN
            (params.emp_min IS NULL OR base.employee_count >= params.emp_min)
            AND (params.emp_max IS NULL OR base.employee_count <= params.emp_max)
          WHEN jsonb_array_length(params.emp_ranges) > 0 THEN
            EXISTS (
              SELECT 1 FROM jsonb_to_recordset(params.emp_ranges) AS r(min_v int, max_v int)
              WHERE base.employee_count >= r.min_v AND (r.max_v IS NULL OR base.employee_count <= r.max_v)
            )
          ELSE true
        END
      )
  ) t
  GROUP BY token
),
sources AS (
  SELECT token AS id, count(*) AS count FROM (
    SELECT unnest(base.source_tokens) AS token
    FROM base, params
    WHERE (cardinality(params.niche_exc) = 0 OR base.niche_tokens IS NULL OR NOT (base.niche_tokens && params.niche_exc))
      AND (cardinality(params.niche_inc) = 0 OR (base.niche_tokens IS NOT NULL AND base.niche_tokens && params.niche_inc))
      AND (cardinality(params.country_exc) = 0 OR base.country_id IS NULL OR NOT (base.country_id = ANY(params.country_exc)))
      AND (cardinality(params.country_inc) = 0 OR base.country_id = ANY(params.country_inc))
      AND (cardinality(params.industry_exc) = 0 OR base.industry_id IS NULL OR NOT (base.industry_id = ANY(params.industry_exc)))
      AND (cardinality(params.industry_inc) = 0 OR base.industry_id = ANY(params.industry_inc))
      AND (cardinality(params.emailstatus_exc) = 0 OR base.email_status IS NULL OR NOT (base.email_status = ANY(params.emailstatus_exc)))
      AND (cardinality(params.emailstatus_inc) = 0 OR base.email_status = ANY(params.emailstatus_inc))
      AND (cardinality(params.phonetype_exc) = 0 OR base.phone_type IS NULL OR NOT (base.phone_type = ANY(params.phonetype_exc)))
      AND (cardinality(params.phonetype_inc) = 0 OR base.phone_type = ANY(params.phonetype_inc))
      AND (
        CASE
          WHEN params.emp_min IS NOT NULL OR params.emp_max IS NOT NULL THEN
            (params.emp_min IS NULL OR base.employee_count >= params.emp_min)
            AND (params.emp_max IS NULL OR base.employee_count <= params.emp_max)
          WHEN jsonb_array_length(params.emp_ranges) > 0 THEN
            EXISTS (
              SELECT 1 FROM jsonb_to_recordset(params.emp_ranges) AS r(min_v int, max_v int)
              WHERE base.employee_count >= r.min_v AND (r.max_v IS NULL OR base.employee_count <= r.max_v)
            )
          ELSE true
        END
      )
  ) t
  GROUP BY token
),
industries AS (
  SELECT base.industry_id AS id, count(*) AS count FROM base, params
  WHERE base.industry_id IS NOT NULL
    AND (cardinality(params.niche_exc) = 0 OR base.niche_tokens IS NULL OR NOT (base.niche_tokens && params.niche_exc))
    AND (cardinality(params.niche_inc) = 0 OR (base.niche_tokens IS NOT NULL AND base.niche_tokens && params.niche_inc))
    AND (cardinality(params.country_exc) = 0 OR base.country_id IS NULL OR NOT (base.country_id = ANY(params.country_exc)))
    AND (cardinality(params.country_inc) = 0 OR base.country_id = ANY(params.country_inc))
    AND (cardinality(params.source_exc) = 0 OR base.source_tokens IS NULL OR NOT (base.source_tokens && params.source_exc))
    AND (cardinality(params.source_inc) = 0 OR (base.source_tokens IS NOT NULL AND base.source_tokens && params.source_inc))
    AND (cardinality(params.emailstatus_exc) = 0 OR base.email_status IS NULL OR NOT (base.email_status = ANY(params.emailstatus_exc)))
    AND (cardinality(params.emailstatus_inc) = 0 OR base.email_status = ANY(params.emailstatus_inc))
    AND (cardinality(params.phonetype_exc) = 0 OR base.phone_type IS NULL OR NOT (base.phone_type = ANY(params.phonetype_exc)))
    AND (cardinality(params.phonetype_inc) = 0 OR base.phone_type = ANY(params.phonetype_inc))
    AND (
      CASE
        WHEN params.emp_min IS NOT NULL OR params.emp_max IS NOT NULL THEN
          (params.emp_min IS NULL OR base.employee_count >= params.emp_min)
          AND (params.emp_max IS NULL OR base.employee_count <= params.emp_max)
        WHEN jsonb_array_length(params.emp_ranges) > 0 THEN
          EXISTS (
            SELECT 1 FROM jsonb_to_recordset(params.emp_ranges) AS r(min_v int, max_v int)
            WHERE base.employee_count >= r.min_v AND (r.max_v IS NULL OR base.employee_count <= r.max_v)
          )
        ELSE true
      END
    )
  GROUP BY base.industry_id
),
countries AS (
  SELECT base.country_id AS id, count(*) AS count FROM base, params
  WHERE base.country_id IS NOT NULL
    AND (cardinality(params.niche_exc) = 0 OR base.niche_tokens IS NULL OR NOT (base.niche_tokens && params.niche_exc))
    AND (cardinality(params.niche_inc) = 0 OR (base.niche_tokens IS NOT NULL AND base.niche_tokens && params.niche_inc))
    AND (cardinality(params.industry_exc) = 0 OR base.industry_id IS NULL OR NOT (base.industry_id = ANY(params.industry_exc)))
    AND (cardinality(params.industry_inc) = 0 OR base.industry_id = ANY(params.industry_inc))
    AND (cardinality(params.source_exc) = 0 OR base.source_tokens IS NULL OR NOT (base.source_tokens && params.source_exc))
    AND (cardinality(params.source_inc) = 0 OR (base.source_tokens IS NOT NULL AND base.source_tokens && params.source_inc))
    AND (cardinality(params.emailstatus_exc) = 0 OR base.email_status IS NULL OR NOT (base.email_status = ANY(params.emailstatus_exc)))
    AND (cardinality(params.emailstatus_inc) = 0 OR base.email_status = ANY(params.emailstatus_inc))
    AND (cardinality(params.phonetype_exc) = 0 OR base.phone_type IS NULL OR NOT (base.phone_type = ANY(params.phonetype_exc)))
    AND (cardinality(params.phonetype_inc) = 0 OR base.phone_type = ANY(params.phonetype_inc))
    AND (
      CASE
        WHEN params.emp_min IS NOT NULL OR params.emp_max IS NOT NULL THEN
          (params.emp_min IS NULL OR base.employee_count >= params.emp_min)
          AND (params.emp_max IS NULL OR base.employee_count <= params.emp_max)
        WHEN jsonb_array_length(params.emp_ranges) > 0 THEN
          EXISTS (
            SELECT 1 FROM jsonb_to_recordset(params.emp_ranges) AS r(min_v int, max_v int)
            WHERE base.employee_count >= r.min_v AND (r.max_v IS NULL OR base.employee_count <= r.max_v)
          )
        ELSE true
      END
    )
  GROUP BY base.country_id
),
email_statuses AS (
  SELECT base.email_status AS id, count(*) AS count FROM base, params
  WHERE base.email_status IS NOT NULL AND base.email_status <> ''
    AND (cardinality(params.niche_exc) = 0 OR base.niche_tokens IS NULL OR NOT (base.niche_tokens && params.niche_exc))
    AND (cardinality(params.niche_inc) = 0 OR (base.niche_tokens IS NOT NULL AND base.niche_tokens && params.niche_inc))
    AND (cardinality(params.country_exc) = 0 OR base.country_id IS NULL OR NOT (base.country_id = ANY(params.country_exc)))
    AND (cardinality(params.country_inc) = 0 OR base.country_id = ANY(params.country_inc))
    AND (cardinality(params.industry_exc) = 0 OR base.industry_id IS NULL OR NOT (base.industry_id = ANY(params.industry_exc)))
    AND (cardinality(params.industry_inc) = 0 OR base.industry_id = ANY(params.industry_inc))
    AND (cardinality(params.source_exc) = 0 OR base.source_tokens IS NULL OR NOT (base.source_tokens && params.source_exc))
    AND (cardinality(params.source_inc) = 0 OR (base.source_tokens IS NOT NULL AND base.source_tokens && params.source_inc))
    AND (cardinality(params.phonetype_exc) = 0 OR base.phone_type IS NULL OR NOT (base.phone_type = ANY(params.phonetype_exc)))
    AND (cardinality(params.phonetype_inc) = 0 OR base.phone_type = ANY(params.phonetype_inc))
    AND (
      CASE
        WHEN params.emp_min IS NOT NULL OR params.emp_max IS NOT NULL THEN
          (params.emp_min IS NULL OR base.employee_count >= params.emp_min)
          AND (params.emp_max IS NULL OR base.employee_count <= params.emp_max)
        WHEN jsonb_array_length(params.emp_ranges) > 0 THEN
          EXISTS (
            SELECT 1 FROM jsonb_to_recordset(params.emp_ranges) AS r(min_v int, max_v int)
            WHERE base.employee_count >= r.min_v AND (r.max_v IS NULL OR base.employee_count <= r.max_v)
          )
        ELSE true
      END
    )
  GROUP BY base.email_status
),
phone_types AS (
  SELECT base.phone_type AS id, count(*) AS count FROM base, params
  WHERE base.phone_type IS NOT NULL AND base.phone_type <> ''
    AND (cardinality(params.niche_exc) = 0 OR base.niche_tokens IS NULL OR NOT (base.niche_tokens && params.niche_exc))
    AND (cardinality(params.niche_inc) = 0 OR (base.niche_tokens IS NOT NULL AND base.niche_tokens && params.niche_inc))
    AND (cardinality(params.country_exc) = 0 OR base.country_id IS NULL OR NOT (base.country_id = ANY(params.country_exc)))
    AND (cardinality(params.country_inc) = 0 OR base.country_id = ANY(params.country_inc))
    AND (cardinality(params.industry_exc) = 0 OR base.industry_id IS NULL OR NOT (base.industry_id = ANY(params.industry_exc)))
    AND (cardinality(params.industry_inc) = 0 OR base.industry_id = ANY(params.industry_inc))
    AND (cardinality(params.source_exc) = 0 OR base.source_tokens IS NULL OR NOT (base.source_tokens && params.source_exc))
    AND (cardinality(params.source_inc) = 0 OR (base.source_tokens IS NOT NULL AND base.source_tokens && params.source_inc))
    AND (cardinality(params.emailstatus_exc) = 0 OR base.email_status IS NULL OR NOT (base.email_status = ANY(params.emailstatus_exc)))
    AND (cardinality(params.emailstatus_inc) = 0 OR base.email_status = ANY(params.emailstatus_inc))
    AND (
      CASE
        WHEN params.emp_min IS NOT NULL OR params.emp_max IS NOT NULL THEN
          (params.emp_min IS NULL OR base.employee_count >= params.emp_min)
          AND (params.emp_max IS NULL OR base.employee_count <= params.emp_max)
        WHEN jsonb_array_length(params.emp_ranges) > 0 THEN
          EXISTS (
            SELECT 1 FROM jsonb_to_recordset(params.emp_ranges) AS r(min_v int, max_v int)
            WHERE base.employee_count >= r.min_v AND (r.max_v IS NULL OR base.employee_count <= r.max_v)
          )
        ELSE true
      END
    )
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
