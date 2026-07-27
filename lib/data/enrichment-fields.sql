-- Run once in the Supabase SQL editor (see docs/adr/0002-virtual-column-enrichment-filtering.md,
-- issue #32, parent spec #31).
-- NOTE: run virtual-columns.sql (ticket #33) before this file — the entity
-- wrappers below call virtual_filters_match, defined there, so an
-- already-active virtual-column filter also scopes the discovery sample,
-- exactly like it scopes company_filter_options/person_filter_options.
--
-- RPC: sampled enrichment-field discovery, scoped to the currently active
-- list filters. Backs the "Add column from enrichment" field picker — for
-- each enrichment key present in a bounded sample of the filtered set, infers
-- a filterable type (Text/Number/Boolean/List/Date) from the dominant value
-- shape and returns a capped list of distinct sample values (for a later
-- value picker). Deliberately samples rather than running
-- `DISTINCT jsonb_object_keys` over the whole table: that's a multi-second
-- full scan at ~109k rows, and the picker needs to open fast even on the
-- unfiltered table. The `LIMIT sample_size` inside each entity's `filtered`
-- CTE (below) has no ORDER BY, so Postgres can stop scanning as soon as it
-- has enough matching rows instead of materializing the whole filtered set.
--
-- Two thin entity-specific wrappers (company_enrichment_fields,
-- person_enrichment_fields) apply that entity's filters and sampling, then
-- both hand their sampled custom_data off to the shared
-- enrichment_field_discovery function below — mirroring the
-- company_filter_options / person_filter_options split in
-- canonical-columns.sql / people-canonical-columns.sql, but factoring out the
-- part that doesn't differ between entities (key/type/value discovery).

-- Housekeeping keys never surface in the picker. Mirrors isHousekeepingKey in
-- lib/data/custom-data.ts exactly (same blocklist, same `pushed_to_*` /
-- `*_at` suffix rules); `extra_blocked` lets the People wrapper layer on
-- PERSON_EXTRA_BLOCKED_KEYS the way filterCustomData's extraBlockedKeys does.
CREATE OR REPLACE FUNCTION enrichment_key_is_blocked(key text, extra_blocked text[] DEFAULT '{}'::text[])
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT
    key = ANY(ARRAY['naics', 'aiark_id', 'industries', 'legal_name', 'ai_ark_approaches',
                     'pushed_to_clay', 'created_at', 'updated_at', 'company_type'])
    OR key LIKE 'pushed_to_%'
    OR key LIKE '%\_at' ESCAPE '\'
    OR key = ANY(extra_blocked);
$$;

-- Classifies a single custom_data value into one of the five filterable
-- types, or 'Empty'. Per the ADR, real `custom_data` stores the same key as
-- different shapes across rows (numbers as strings, unit-bearing strings,
-- sentinels, unrendered Clay templates) — so string values are pattern-
-- matched, not just typeof-checked. The Number regex (`^-?[0-9.]+$`) matches
-- the cast guard virtual-column filtering uses, so a value classified Number
-- here is guaranteed castable there. Date compares/detects ISO-prefixed
-- strings only (`YYYY-MM-DD...`), consistent with the lexicographic (no-cast)
-- Date comparison the ADR decided on.
CREATE OR REPLACE FUNCTION enrichment_value_type(value jsonb)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN value IS NULL OR value = 'null'::jsonb THEN 'Empty'
    WHEN jsonb_typeof(value) = 'array' AND jsonb_array_length(value) = 0 THEN 'Empty'
    WHEN jsonb_typeof(value) = 'array' THEN 'List'
    WHEN jsonb_typeof(value) = 'boolean' THEN 'Boolean'
    WHEN jsonb_typeof(value) = 'number' THEN 'Number'
    WHEN jsonb_typeof(value) = 'object' THEN 'Text'
    ELSE (
      CASE
        WHEN trim(both from (value #>> '{}')) IN ('', '-') THEN 'Empty'
        WHEN (value #>> '{}') ~ '^\{\{.*\}\}$' THEN 'Empty'
        WHEN (value #>> '{}') ~ '^\d{4}-\d{2}-\d{2}' THEN 'Date'
        WHEN (value #>> '{}') ~ '^-?[0-9.]+$' THEN 'Number'
        WHEN lower(value #>> '{}') IN ('true', 'false') THEN 'Boolean'
        ELSE 'Text'
      END
    )
  END;
$$;

-- Shared discovery core: given an array of already-sampled, already-filtered
-- custom_data objects (one entity's `filtered` CTE, aggregated), returns
-- `[{key, type, sampleValues}]` for every non-blocklisted key present in the
-- sample. Type is the dominant (most frequent, then alphabetical to break
-- ties deterministically) non-Empty shape seen for that key; a key whose
-- every sampled value is Empty still surfaces (it's present in the sample)
-- but falls back to Text since there's no dominant shape to infer from.
-- Sample values for List keys are the individual array elements (what a
-- value picker offers), not the serialized array; for every other type it's
-- the scalar value as text. Empty values are excluded from both the type
-- vote and the sample-value list — they're not real data.
CREATE OR REPLACE FUNCTION enrichment_field_discovery(
  samples jsonb[],
  extra_blocked_keys text[] DEFAULT '{}'::text[],
  max_values_per_key int DEFAULT 25
) RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH kv AS (
    SELECT e.key, e.value
    FROM unnest(samples) AS s(custom_data),
         LATERAL jsonb_each(COALESCE(s.custom_data, '{}'::jsonb)) AS e(key, value)
    WHERE NOT enrichment_key_is_blocked(e.key, extra_blocked_keys)
  ),
  classified AS (
    SELECT key, value, enrichment_value_type(value) AS value_type
    FROM kv
  ),
  key_type_counts AS (
    SELECT key, value_type, count(*) AS n
    FROM classified
    WHERE value_type <> 'Empty'
    GROUP BY key, value_type
  ),
  key_types AS (
    SELECT DISTINCT ON (key) key, value_type AS type
    FROM key_type_counts
    ORDER BY key, n DESC, value_type ASC
  ),
  -- Flattens List values to their individual elements; every other type
  -- passes its scalar value through as text.
  value_candidates AS (
    SELECT c.key,
      CASE WHEN jsonb_typeof(c.value) = 'array' THEN elem.val ELSE (c.value #>> '{}') END AS val
    FROM classified c
    LEFT JOIN LATERAL jsonb_array_elements_text(
      CASE WHEN jsonb_typeof(c.value) = 'array' THEN c.value ELSE '[]'::jsonb END
    ) AS elem(val) ON true
    WHERE c.value_type <> 'Empty'
  ),
  distinct_values AS (
    SELECT key, val, count(*) AS n
    FROM value_candidates
    WHERE val IS NOT NULL AND trim(val) NOT IN ('', '-') AND val !~ '^\{\{.*\}\}$'
    GROUP BY key, val
  ),
  ranked_values AS (
    SELECT key, val, row_number() OVER (PARTITION BY key ORDER BY n DESC, val ASC) AS rn
    FROM distinct_values
  ),
  capped_values AS (
    SELECT key, jsonb_agg(val ORDER BY rn) AS values
    FROM ranked_values
    WHERE rn <= max_values_per_key
    GROUP BY key
  ),
  all_keys AS (SELECT DISTINCT key FROM kv)
  SELECT COALESCE(jsonb_agg(
    jsonb_build_object(
      'key', ak.key,
      'type', COALESCE(kt.type, 'Text'),
      'sampleValues', COALESCE(cv.values, '[]'::jsonb)
    ) ORDER BY ak.key
  ), '[]'::jsonb)
  FROM all_keys ak
  LEFT JOIN key_types kt ON kt.key = ak.key
  LEFT JOIN capped_values cv ON cv.key = ak.key;
$$;

-- RPC: enrichment-field discovery scoped to the active /companies filters.
-- `filters` is the same JSON-serialized CompanyListFilters payload
-- company_filter_options takes (see lib/data/companies.ts
-- toFilterOptionsRpcPayload) — the `filtered` CTE below applies every
-- dimension at once (unlike company_filter_options' per-facet CTEs, which
-- each omit their own dimension), since discovery isn't a facet and has no
-- "exclude this filter's own contribution" concept.
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
      AND (jsonb_array_length(p.virtual_filters) = 0 OR virtual_filters_match(c.custom_data, p.virtual_filters))
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

-- RPC: same as company_enrichment_fields but scoped to /people. `filters` is
-- the person_filter_options payload (lib/data/people.ts
-- toFilterOptionsRpcPayload, note: also carries jobTitle). Blocks
-- PERSON_EXTRA_BLOCKED_KEYS (lib/data/people.ts) in addition to the shared
-- blocklist, mirroring filterCustomData(data.custom_data,
-- PERSON_EXTRA_BLOCKED_KEYS) on the People Detail read path.
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
      AND (jsonb_array_length(pr.virtual_filters) = 0 OR virtual_filters_match(p.custom_data, pr.virtual_filters))
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
