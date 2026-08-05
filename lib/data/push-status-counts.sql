-- Run once in the Supabase SQL editor (Push Status Filters epic #125, E1 / issue #133).
-- NOTE: on a fresh database, run virtual-columns.sql, canonical-columns.sql, and
-- people-canonical-columns.sql before this file — the two functions below reuse
-- the same base-scan predicates (and virtual_filter_predicate_matches) those files
-- define, and read the canonical columns those files add.
--
-- Phase 2 of the push-status filter: live per-option preview counts for the
-- popover. Given the current filter set (every *other* active filter) plus a
-- selected client + platform, return { pushed, notPushed } so the operator can
-- see "Not yet pushed (3,000) / Already pushed (1,000)" before committing.
--
-- Deliberately a *separate* lightweight RPC rather than folding push counts into
-- the 6-facet *_filter_options functions: these counts are only needed while the
-- popover is open with a client selected, not on every page render. The push
-- status dimension is "self-excluded" (like a facet's own count) — the scan
-- applies every base + facet filter EXCEPT push status, then splits the surviving
-- rows into pushed vs not-pushed for the given client/platform. So
-- `pushed + notPushed` equals the total the filter would yield for that
-- client/platform, matching what applying the filter actually returns.

-- People: person-level push semantics — a person is "pushed" iff a platform_pushes
-- row exists for (person, client, platform). Mirrors the predicate in
-- person_filter_options / people_matching_virtual_filters; keep in lockstep so the
-- preview counts match what the filter yields.
CREATE OR REPLACE FUNCTION person_push_status_counts(
  filters jsonb DEFAULT '{}'::jsonb,
  client_id uuid DEFAULT NULL,
  platform text DEFAULT NULL
)
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
    -- The client + platform being previewed (function args aliased here so the
    -- count subqueries reference them qualified as pr.*, never an ambiguous bare
    -- `platform` that could collide with platform_pushes.platform).
    client_id AS push_client_id,
    platform AS push_platform,
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
-- Every active filter EXCEPT push status (the dimension being previewed), so the
-- surviving rows are exactly what the rest of the view already narrows to. The
-- base clauses mirror person_filter_options' `base`; the six facet clauses mirror
-- its per-facet subqueries. Push status is intentionally omitted here.
scoped AS (
  SELECT
    EXISTS (
      SELECT 1 FROM platform_pushes pp
      WHERE pp.person_id = p.id
        AND pp.client_id = pr.push_client_id
        AND pp.platform = pr.push_platform
    ) AS is_pushed
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
    -- Grouped virtual-filter fold (ticket #117) — identical to the copies in
    -- people-canonical-columns.sql / virtual-columns.sql; keep in lockstep.
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
    -- Six facet dimensions, applied in full (unlike filter_options, no self is
    -- excluded here — the excluded dimension is push status, not a facet).
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
)
SELECT jsonb_build_object(
  'pushed', COALESCE(count(*) FILTER (WHERE is_pushed), 0),
  'notPushed', COALESCE(count(*) FILTER (WHERE NOT is_pushed), 0)
) FROM scoped;
$$;

-- Companies: "has work left" semantics — a company is "not yet pushed" (has work
-- left) iff it has at least one linked person not yet pushed for this
-- client/platform, and "already pushed" iff it has people AND none of them still
-- need pushing. A company with zero linked people counts as neither (identical to
-- company_filter_options' push-status clause). Keep in lockstep with that clause.
CREATE OR REPLACE FUNCTION company_push_status_counts(
  filters jsonb DEFAULT '{}'::jsonb,
  client_id uuid DEFAULT NULL,
  platform text DEFAULT NULL
)
RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH params AS (
  SELECT
    NULLIF(trim(both from (filters->>'search')), '') AS search,
    (filters->>'employeeMin')::int AS emp_min,
    (filters->>'employeeMax')::int AS emp_max,
    COALESCE(filters->'employeeBucketRanges', '[]'::jsonb) AS emp_ranges,
    COALESCE(filters->>'email', 'any') AS email_filter,
    COALESCE(filters->>'phone', 'any') AS phone_filter,
    COALESCE(filters->'virtualFilters', '{}'::jsonb) AS virtual_filters,
    client_id AS push_client_id,
    platform AS push_platform,
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
scoped AS (
  SELECT
    EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id) AS has_people,
    EXISTS (
      SELECT 1 FROM people pe
      WHERE pe.company_id = c.id
        AND NOT EXISTS (
          SELECT 1 FROM platform_pushes pp
          WHERE pp.person_id = pe.id
            AND pp.client_id = pr.push_client_id
            AND pp.platform = pr.push_platform
        )
    ) AS has_work_left
  FROM companies c, params pr
  WHERE
    (pr.search IS NULL OR c.company_name ILIKE '%' || pr.search || '%' OR c.domain ILIKE '%' || pr.search || '%')
    AND (
      CASE
        WHEN pr.emp_min IS NOT NULL OR pr.emp_max IS NOT NULL THEN
          (pr.emp_min IS NULL OR c.employee_count >= pr.emp_min)
          AND (pr.emp_max IS NULL OR c.employee_count <= pr.emp_max)
        WHEN jsonb_array_length(pr.emp_ranges) > 0 THEN
          EXISTS (
            SELECT 1 FROM jsonb_to_recordset(pr.emp_ranges) AS r(min_v int, max_v int)
            WHERE c.employee_count >= r.min_v AND (r.max_v IS NULL OR c.employee_count <= r.max_v)
          )
        ELSE true
      END
    )
    AND (pr.email_filter = 'any'
      OR (pr.email_filter = 'not_empty' AND c.email IS NOT NULL AND c.email <> '')
      OR (pr.email_filter = 'empty' AND (c.email IS NULL OR c.email = '')))
    AND (pr.phone_filter = 'any'
      OR (pr.phone_filter = 'not_empty' AND c.phone IS NOT NULL AND c.phone <> '')
      OR (pr.phone_filter = 'empty' AND (c.phone IS NULL OR c.phone = '')))
    AND (
      COALESCE(jsonb_array_length(pr.virtual_filters->'groups'), 0) = 0
      OR CASE WHEN COALESCE(pr.virtual_filters->>'combinator', 'and') = 'or' THEN
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(pr.virtual_filters->'groups') AS grp
          WHERE CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
              EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                      WHERE virtual_filter_predicate_matches(c.custom_data, cond))
            ELSE
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                          WHERE NOT virtual_filter_predicate_matches(c.custom_data, cond))
            END
        )
      ELSE
        NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(pr.virtual_filters->'groups') AS grp
          WHERE NOT (CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
              EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                      WHERE virtual_filter_predicate_matches(c.custom_data, cond))
            ELSE
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                          WHERE NOT virtual_filter_predicate_matches(c.custom_data, cond))
            END)
        )
      END
    )
    AND (cardinality(pr.niche_exc) = 0 OR c.niche IS NULL OR NOT (c.niche = ANY(pr.niche_exc)))
    AND (cardinality(pr.niche_inc) = 0 OR c.niche = ANY(pr.niche_inc))
    AND (cardinality(pr.source_exc) = 0 OR c.source_tokens IS NULL OR NOT (c.source_tokens && pr.source_exc))
    AND (cardinality(pr.source_inc) = 0 OR (c.source_tokens IS NOT NULL AND c.source_tokens && pr.source_inc))
    AND (cardinality(pr.industry_exc) = 0 OR c.industry_id IS NULL OR NOT (c.industry_id = ANY(pr.industry_exc)))
    AND (cardinality(pr.industry_inc) = 0 OR c.industry_id = ANY(pr.industry_inc))
    AND (cardinality(pr.country_exc) = 0 OR c.country_id IS NULL OR NOT (c.country_id = ANY(pr.country_exc)))
    AND (cardinality(pr.country_inc) = 0 OR c.country_id = ANY(pr.country_inc))
    AND (cardinality(pr.emailstatus_exc) = 0 OR c.email_status IS NULL OR NOT (c.email_status = ANY(pr.emailstatus_exc)))
    AND (cardinality(pr.emailstatus_inc) = 0 OR c.email_status = ANY(pr.emailstatus_inc))
    AND (cardinality(pr.phonetype_exc) = 0 OR c.phone_type IS NULL OR NOT (c.phone_type = ANY(pr.phonetype_exc)))
    AND (cardinality(pr.phonetype_inc) = 0 OR c.phone_type = ANY(pr.phonetype_inc))
)
SELECT jsonb_build_object(
  -- not_pushed == has work left; pushed == has people AND no work left.
  'notPushed', COALESCE(count(*) FILTER (WHERE has_work_left), 0),
  'pushed', COALESCE(count(*) FILTER (WHERE has_people AND NOT has_work_left), 0)
) FROM scoped;
$$;
