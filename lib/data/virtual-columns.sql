-- Run once in the Supabase SQL editor (see docs/adr/0002-virtual-column-enrichment-filtering.md,
-- spec issue #31, ticket #33).
--
-- The single place a virtual-column predicate over `custom_data` is
-- evaluated, so the filtered list/count, the facet computation, CSV export,
-- and the Clay/GHL push all agree on what a filter matches — see
-- lib/data/companies.ts / lib/data/people.ts for the callers, and
-- canonical-columns.sql / people-canonical-columns.sql for the facet RPCs
-- this threads into. Ticket #33 introduces this seam with no operator UI;
-- follow-on tickets (#34 Text, #35 Number/Date, #36 Boolean/List) add the
-- app-side wiring that populates `filters.virtualFilters`.

-- Empty-value normalization, defined once and reused by every "is empty" /
-- "is not empty" case below. Mirrors (but is not identical to) the simpler
-- display-only isEmptyValue in lib/data/custom-data.ts: filtering also treats
-- whitespace-only strings, the "-" sentinel, and unrendered Clay templates
-- ("{{ ... }}") as empty, since real enrichment data carries all three as
-- placeholder junk (see CONTEXT.md's "Empty (enrichment value)" glossary
-- entry). The string is trimmed once up front so a template with stray
-- surrounding whitespace ("  {{ x }}  ") normalizes the same as a clean one —
-- every branch below reads the trimmed text, not the raw one.
CREATE OR REPLACE FUNCTION is_empty_enrichment_value(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    v IS NULL
    OR v = 'null'::jsonb
    OR (jsonb_typeof(v) = 'array' AND jsonb_array_length(v) = 0)
    OR (
      jsonb_typeof(v) = 'string'
      AND (
        trim(both from (v #>> '{}')) = ''
        OR trim(both from (v #>> '{}')) = '-'
        OR trim(both from (v #>> '{}')) ~ '^\{\{.*\}\}$'
      )
    )
$$;

-- Cast-safe numeric read of an enrichment value: NULL (never an exception)
-- for anything that isn't a clean number, so a Number filter drops
-- non-numeric junk ("$10", "-", "{{ 0 }}", stray strings) instead of 500ing
-- the request (ADR-0002). Regex-guards before casting because Postgres has
-- no try_cast. Handles both a real JSON number and a numeric-looking string,
-- since the same custom_data key holds either shape across rows.
CREATE OR REPLACE FUNCTION enrichment_numeric(v jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN v IS NULL THEN NULL
    WHEN jsonb_typeof(v) = 'number' THEN (v #>> '{}')::numeric
    WHEN jsonb_typeof(v) = 'string' AND (v #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (v #>> '{}')::numeric
    ELSE NULL
  END
$$;

-- Cast-safe ISO-date text read: NULL for anything that isn't a YYYY-MM-DD-
-- prefixed string. Comparison stays lexicographic on the returned text (not a
-- date cast) because ISO dates sort correctly as text and a text compare
-- can't throw on a malformed date the way a `::date` cast can (ADR-0002).
CREATE OR REPLACE FUNCTION enrichment_date_text(v jsonb) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN jsonb_typeof(v) = 'string' AND (v #>> '{}') ~ '^\d{4}-\d{2}-\d{2}' THEN (v #>> '{}')
    ELSE NULL
  END
$$;

-- Evaluates one virtual-column filter `{key, type, operator, value}` against
-- a row's custom_data. Every branch is written so a mismatched/dirty value
-- excludes the row rather than raising — no PostgREST text-path lexicographic
-- comparison for Number (enrichment_numeric casts to numeric so 9 < 90
-- compares correctly), and Date stays a guarded text compare (see above).
-- List "contains" uses jsonb containment against the array's individual
-- members, not a substring/ILIKE match on the serialized array, so "a3"
-- never matches "a30". Named `_predicate_matches` (singular filter) to keep
-- it visually distinct from `virtual_filters_match` below (plural, ANDs many)
-- — the two are easy to transpose at a call site otherwise.
CREATE OR REPLACE FUNCTION virtual_filter_predicate_matches(data jsonb, f jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  WITH p AS (
    SELECT
      f->>'key' AS key,
      f->>'type' AS type,
      f->>'operator' AS operator,
      f->'value' AS value
  ),
  v AS (
    SELECT data -> p.key AS raw FROM p
  )
  SELECT CASE p.type
    WHEN 'text' THEN
      CASE p.operator
        WHEN 'is' THEN COALESCE(v.raw #>> '{}', '') = COALESCE(p.value #>> '{}', '')
        WHEN 'is_not' THEN COALESCE(v.raw #>> '{}', '') <> COALESCE(p.value #>> '{}', '')
        WHEN 'contains' THEN COALESCE(v.raw #>> '{}', '') ILIKE ('%' || (p.value #>> '{}') || '%')
        WHEN 'not_contains' THEN COALESCE(v.raw #>> '{}', '') NOT ILIKE ('%' || (p.value #>> '{}') || '%')
        WHEN 'is_empty' THEN is_empty_enrichment_value(v.raw)
        WHEN 'is_not_empty' THEN NOT is_empty_enrichment_value(v.raw)
        ELSE false
      END
    WHEN 'number' THEN
      CASE p.operator
        WHEN 'is' THEN enrichment_numeric(v.raw) IS NOT NULL AND enrichment_numeric(v.raw) = enrichment_numeric(p.value)
        WHEN 'is_not' THEN enrichment_numeric(v.raw) IS NOT NULL AND enrichment_numeric(v.raw) <> enrichment_numeric(p.value)
        WHEN 'gt' THEN enrichment_numeric(v.raw) IS NOT NULL AND enrichment_numeric(v.raw) > enrichment_numeric(p.value)
        WHEN 'lt' THEN enrichment_numeric(v.raw) IS NOT NULL AND enrichment_numeric(v.raw) < enrichment_numeric(p.value)
        WHEN 'between' THEN
          enrichment_numeric(v.raw) IS NOT NULL
          AND enrichment_numeric(v.raw) BETWEEN enrichment_numeric(p.value->0) AND enrichment_numeric(p.value->1)
        ELSE false
      END
    WHEN 'boolean' THEN
      CASE p.operator
        WHEN 'is_true' THEN
          CASE jsonb_typeof(v.raw)
            WHEN 'boolean' THEN (v.raw #>> '{}') = 'true'
            WHEN 'string' THEN lower(v.raw #>> '{}') IN ('true', 'yes', '1')
            ELSE false
          END
        WHEN 'is_false' THEN
          CASE jsonb_typeof(v.raw)
            WHEN 'boolean' THEN (v.raw #>> '{}') = 'false'
            WHEN 'string' THEN lower(v.raw #>> '{}') IN ('false', 'no', '0')
            ELSE false
          END
        ELSE false
      END
    WHEN 'list' THEN
      CASE p.operator
        WHEN 'contains' THEN jsonb_typeof(v.raw) = 'array' AND v.raw @> jsonb_build_array(p.value)
        WHEN 'not_contains' THEN NOT (jsonb_typeof(v.raw) = 'array' AND v.raw @> jsonb_build_array(p.value))
        WHEN 'is_empty' THEN is_empty_enrichment_value(v.raw)
        WHEN 'is_not_empty' THEN NOT is_empty_enrichment_value(v.raw)
        ELSE false
      END
    WHEN 'date' THEN
      CASE p.operator
        WHEN 'on' THEN enrichment_date_text(v.raw) IS NOT NULL AND enrichment_date_text(v.raw) = enrichment_date_text(p.value)
        WHEN 'before' THEN enrichment_date_text(v.raw) IS NOT NULL AND enrichment_date_text(v.raw) < enrichment_date_text(p.value)
        WHEN 'after' THEN enrichment_date_text(v.raw) IS NOT NULL AND enrichment_date_text(v.raw) > enrichment_date_text(p.value)
        WHEN 'between' THEN
          enrichment_date_text(v.raw) IS NOT NULL
          AND enrichment_date_text(v.raw) BETWEEN enrichment_date_text(p.value->0) AND enrichment_date_text(p.value->1)
        ELSE false
      END
    ELSE false
  END
  FROM p, v;
$$;

-- ANDs a jsonb array of virtual-column filters together (an empty/null array
-- matches every row — the no-virtual-filters-active case that keeps existing
-- native filtering behavior unchanged). Shared by the facet RPCs
-- (company_filter_options/person_filter_options) and the matching-ids RPCs
-- below, so list/export/push and facets can never disagree on a virtual
-- filter's result.
CREATE OR REPLACE FUNCTION virtual_filters_match(data jsonb, filters jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(COALESCE(filters, '[]'::jsonb)) AS f
    WHERE NOT virtual_filter_predicate_matches(data, f)
  )
$$;

-- Resolves the id set a request's *entire* filter set (native + virtual)
-- narrows to, in one scan. Takes the same jsonb shape company_filter_options
-- does (lib/data/companies.ts toFilterOptionsRpcPayload) and applies the
-- identical native predicate (search / employee size / niche / source /
-- industry / country / email+phone presence / emailStatus / phoneType —
-- mirrors applyCompanyFilters and company_filter_options' `base` CTE)
-- ANDed with virtual_filters_match. Applying the native filters here too
-- (not just the virtual half) matters: without them this would scan the
-- *whole* companies table on every virtual-filtered request regardless of
-- how narrow the native filters already are, instead of the same bounded
-- working set the native filters produce — which is what "no path pays for
-- a second scan" (ticket #33) actually requires. The companies/people list,
-- export, and Clay/GHL push functions (lib/data/companies.ts,
-- lib/data/people.ts) call this only when `filters.virtualFilters` is
-- non-empty, then intersect via `.in("id", ids)`; when no virtual filter is
-- active they skip this entirely and existing native-filtering behavior is
-- unchanged.
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
    AND virtual_filters_match(c.custom_data, p.virtual_filters)
$$;

-- Mirrors companies_matching_virtual_filters for /people — same jsonb shape
-- as person_filter_options expects (lib/data/people.ts toFilterOptionsRpcPayload),
-- same reasoning for why native filters are re-applied here (bounds the scan
-- to the real working set instead of the whole people table).
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
    AND virtual_filters_match(p.custom_data, pr.virtual_filters)
$$;
