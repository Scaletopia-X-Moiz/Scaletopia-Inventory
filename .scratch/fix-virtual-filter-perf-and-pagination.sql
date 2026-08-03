-- Perf + correctness fix for the virtual-columns feature (tickets #37, #41).
-- Paste this whole file into the Supabase SQL editor and run it once.
-- Safe to re-run (all six statements are CREATE OR REPLACE FUNCTION).
--
-- Fix 1 (tickets #37, #41 — facet/discovery timeout):
--   company_filter_options, person_filter_options, company_enrichment_fields,
--   and person_enrichment_fields were calling the virtual_filters_match()
--   wrapper as an opaque per-row function call. Because that function's body
--   contains an EXISTS (a SubLink), Postgres's planner can never inline it —
--   every row pays the cost of a full nested subquery execution, which times
--   out at ~110k rows once a virtual filter is active. This is the same bug
--   class already fixed once for the list-query RPCs (ticket #34) by inlining
--   the `NOT EXISTS (... virtual_filter_predicate_matches ...)` shape
--   directly into the WHERE clause instead of calling through the wrapper.
--   This file applies that same inlining fix to all four remaining RPCs.
--
-- Fix 2 (unstable multi-page pagination):
--   companies_matching_virtual_filters / people_matching_virtual_filters had
--   no ORDER BY. The app pages through matches >1000 rows via repeated
--   .range() calls, and Postgres does not guarantee identical row order
--   across separate executions of an unordered query — so pages could
--   silently duplicate or drop rows, corrupting the total/list/export/push
--   set for large virtual-filter matches. Adding ORDER BY id makes paging
--   stable.

-- Fix 1: company_filter_options
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

-- Fix 1: person_filter_options
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
    AND (jsonb_array_length(pr.virtual_filters) = 0 OR NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(pr.virtual_filters) AS vf
      WHERE NOT virtual_filter_predicate_matches(p.custom_data, vf)
    ))
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

-- Fix 1: company_enrichment_fields
CREATE OR REPLACE FUNCTION company_enrichment_fields(
  filters jsonb DEFAULT '{}'::jsonb,
  sample_size int DEFAULT 500,
  max_values_per_key int DEFAULT 25
) RETURNS jsonb LANGUAGE sql STABLE AS $$
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
  filtered AS (
    SELECT c.custom_data
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
      AND (cardinality(p.niche_inc) = 0 OR c.niche = ANY(p.niche_inc))
      AND (cardinality(p.niche_exc) = 0 OR c.niche IS NULL OR NOT (c.niche = ANY(p.niche_exc)))
      AND (cardinality(p.source_inc) = 0 OR (c.source_tokens IS NOT NULL AND c.source_tokens && p.source_inc))
      AND (cardinality(p.source_exc) = 0 OR c.source_tokens IS NULL OR NOT (c.source_tokens && p.source_exc))
      AND (cardinality(p.industry_inc) = 0 OR c.industry_id = ANY(p.industry_inc))
      AND (cardinality(p.industry_exc) = 0 OR c.industry_id IS NULL OR NOT (c.industry_id = ANY(p.industry_exc)))
      AND (cardinality(p.country_inc) = 0 OR c.country_id = ANY(p.country_inc))
      AND (cardinality(p.country_exc) = 0 OR c.country_id IS NULL OR NOT (c.country_id = ANY(p.country_exc)))
      AND (cardinality(p.emailstatus_inc) = 0 OR c.email_status = ANY(p.emailstatus_inc))
      AND (cardinality(p.emailstatus_exc) = 0 OR c.email_status IS NULL OR NOT (c.email_status = ANY(p.emailstatus_exc)))
      AND (cardinality(p.phonetype_inc) = 0 OR c.phone_type = ANY(p.phonetype_inc))
      AND (cardinality(p.phonetype_exc) = 0 OR c.phone_type IS NULL OR NOT (c.phone_type = ANY(p.phonetype_exc)))
      AND (jsonb_array_length(p.virtual_filters) = 0 OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(p.virtual_filters) AS vf
        WHERE NOT virtual_filter_predicate_matches(c.custom_data, vf)
      ))
    LIMIT sample_size
  )
  SELECT jsonb_build_object(
    'fields', enrichment_field_discovery(
      (SELECT COALESCE(array_agg(custom_data), ARRAY[]::jsonb[]) FROM filtered),
      ARRAY[]::text[],
      max_values_per_key
    ),
    'sampledRows', (SELECT count(*) FROM filtered)
  );
$$;

-- Fix 1: person_enrichment_fields
CREATE OR REPLACE FUNCTION person_enrichment_fields(
  filters jsonb DEFAULT '{}'::jsonb,
  sample_size int DEFAULT 500,
  max_values_per_key int DEFAULT 25
) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH params AS (
    SELECT
      NULLIF(trim(both from (filters->>'search')), '') AS search,
      NULLIF(trim(both from (filters->>'jobTitle')), '') AS job_title,
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
  filtered AS (
    SELECT p.custom_data
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
      AND (cardinality(pr.niche_inc) = 0 OR (p.niche_tokens IS NOT NULL AND p.niche_tokens && pr.niche_inc))
      AND (cardinality(pr.niche_exc) = 0 OR p.niche_tokens IS NULL OR NOT (p.niche_tokens && pr.niche_exc))
      AND (cardinality(pr.source_inc) = 0 OR (p.source_tokens IS NOT NULL AND p.source_tokens && pr.source_inc))
      AND (cardinality(pr.source_exc) = 0 OR p.source_tokens IS NULL OR NOT (p.source_tokens && pr.source_exc))
      AND (cardinality(pr.industry_inc) = 0 OR p.industry_id = ANY(pr.industry_inc))
      AND (cardinality(pr.industry_exc) = 0 OR p.industry_id IS NULL OR NOT (p.industry_id = ANY(pr.industry_exc)))
      AND (cardinality(pr.country_inc) = 0 OR p.country_id = ANY(pr.country_inc))
      AND (cardinality(pr.country_exc) = 0 OR p.country_id IS NULL OR NOT (p.country_id = ANY(pr.country_exc)))
      AND (cardinality(pr.emailstatus_inc) = 0 OR p.email_status = ANY(pr.emailstatus_inc))
      AND (cardinality(pr.emailstatus_exc) = 0 OR p.email_status IS NULL OR NOT (p.email_status = ANY(pr.emailstatus_exc)))
      AND (cardinality(pr.phonetype_inc) = 0 OR p.phone_type = ANY(pr.phonetype_inc))
      AND (cardinality(pr.phonetype_exc) = 0 OR p.phone_type IS NULL OR NOT (p.phone_type = ANY(pr.phonetype_exc)))
      AND (jsonb_array_length(pr.virtual_filters) = 0 OR NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(pr.virtual_filters) AS vf
        WHERE NOT virtual_filter_predicate_matches(p.custom_data, vf)
      ))
    LIMIT sample_size
  )
  SELECT jsonb_build_object(
    'fields', enrichment_field_discovery(
      (SELECT COALESCE(array_agg(custom_data), ARRAY[]::jsonb[]) FROM filtered),
      ARRAY['company_linkedin_id', 'connections_count', 'apollo_id'],
      max_values_per_key
    ),
    'sampledRows', (SELECT count(*) FROM filtered)
  );
$$;

-- Fix 2: companies_matching_virtual_filters (adds ORDER BY c.id)
CREATE OR REPLACE FUNCTION companies_matching_virtual_filters(filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE(id uuid) LANGUAGE sql STABLE AS $$
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
  )
  SELECT c.id
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
    AND (cardinality(p.niche_exc) = 0 OR c.niche IS NULL OR NOT (c.niche = ANY(p.niche_exc)))
    AND (cardinality(p.niche_inc) = 0 OR c.niche = ANY(p.niche_inc))
    AND (cardinality(p.source_exc) = 0 OR c.source_tokens IS NULL OR NOT (c.source_tokens && p.source_exc))
    AND (cardinality(p.source_inc) = 0 OR (c.source_tokens IS NOT NULL AND c.source_tokens && p.source_inc))
    AND (cardinality(p.industry_exc) = 0 OR c.industry_id IS NULL OR NOT (c.industry_id = ANY(p.industry_exc)))
    AND (cardinality(p.industry_inc) = 0 OR c.industry_id = ANY(p.industry_inc))
    AND (cardinality(p.country_exc) = 0 OR c.country_id IS NULL OR NOT (c.country_id = ANY(p.country_exc)))
    AND (cardinality(p.country_inc) = 0 OR c.country_id = ANY(p.country_inc))
    AND (cardinality(p.emailstatus_exc) = 0 OR c.email_status IS NULL OR NOT (c.email_status = ANY(p.emailstatus_exc)))
    AND (cardinality(p.emailstatus_inc) = 0 OR c.email_status = ANY(p.emailstatus_inc))
    AND (cardinality(p.phonetype_exc) = 0 OR c.phone_type IS NULL OR NOT (c.phone_type = ANY(p.phonetype_exc)))
    AND (cardinality(p.phonetype_inc) = 0 OR c.phone_type = ANY(p.phonetype_inc))
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(p.virtual_filters) AS vf
      WHERE NOT virtual_filter_predicate_matches(c.custom_data, vf)
    )
  ORDER BY c.id
$$;

-- Fix 2: people_matching_virtual_filters (adds ORDER BY p.id)
CREATE OR REPLACE FUNCTION people_matching_virtual_filters(filters jsonb DEFAULT '{}'::jsonb)
RETURNS TABLE(id uuid) LANGUAGE sql STABLE AS $$
  WITH params AS (
    SELECT
      NULLIF(trim(both from (filters->>'search')), '') AS search,
      NULLIF(trim(both from (filters->>'jobTitle')), '') AS job_title,
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
  )
  SELECT p.id
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
    AND (cardinality(pr.niche_exc) = 0 OR p.niche_tokens IS NULL OR NOT (p.niche_tokens && pr.niche_exc))
    AND (cardinality(pr.niche_inc) = 0 OR (p.niche_tokens IS NOT NULL AND p.niche_tokens && pr.niche_inc))
    AND (cardinality(pr.source_exc) = 0 OR p.source_tokens IS NULL OR NOT (p.source_tokens && pr.source_exc))
    AND (cardinality(pr.source_inc) = 0 OR (p.source_tokens IS NOT NULL AND p.source_tokens && pr.source_inc))
    AND (cardinality(pr.industry_exc) = 0 OR p.industry_id IS NULL OR NOT (p.industry_id = ANY(pr.industry_exc)))
    AND (cardinality(pr.industry_inc) = 0 OR p.industry_id = ANY(pr.industry_inc))
    AND (cardinality(pr.country_exc) = 0 OR p.country_id IS NULL OR NOT (p.country_id = ANY(pr.country_exc)))
    AND (cardinality(pr.country_inc) = 0 OR p.country_id = ANY(pr.country_inc))
    AND (cardinality(pr.emailstatus_exc) = 0 OR p.email_status IS NULL OR NOT (p.email_status = ANY(pr.emailstatus_exc)))
    AND (cardinality(pr.emailstatus_inc) = 0 OR p.email_status = ANY(pr.emailstatus_inc))
    AND (cardinality(pr.phonetype_exc) = 0 OR p.phone_type IS NULL OR NOT (p.phone_type = ANY(pr.phonetype_exc)))
    AND (cardinality(pr.phonetype_inc) = 0 OR p.phone_type = ANY(pr.phonetype_inc))
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(pr.virtual_filters) AS vf
      WHERE NOT virtual_filter_predicate_matches(p.custom_data, vf)
    )
  ORDER BY p.id
$$;
