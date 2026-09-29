-- T25 / #151: ESP (email provider) filter on People and Companies.
-- Run once in the Supabase SQL editor (applied to swfykpknnfunpapzoudn on
-- 2026-09-29 as migration "t25_esp_filter").
--
-- Teaches the six filter RPCs a new `mxProvider` include/exclude key, read
-- from companies.mx_provider (google, microsoft, other, none). People have no
-- ESP of their own; they use their linked company's value through the LEFT
-- JOIN these functions already do. Also adds an `mxProviders` facet to both
-- *_filter_options results. The facet is scoped by every other filter but
-- never by itself, the same rule as every other facet.
--
-- Semantics match the existing scalar filters in SQL: exclude keeps rows with
-- no ESP (NULL, including people with no company), include never matches
-- them. With no `mxProvider` key in the payload both arrays are empty and
-- every function behaves exactly as before.
--
-- Each body is the live definition as of 2026-09-29 (pg_get_functiondef,
-- md5-verified) with only the ESP lines added; the ticket #25 comments mark
-- them. Each body here is byte-identical (md5) to what is live after the
-- migration. CREATE OR REPLACE is idempotent, so re-running is safe. Rollback:
-- lib/data/ticket-25-rollback.sql.

-- Follow-ups applied the same day: people_matching_virtual_filters matches
-- company_id against hashed company-id sets instead of reading the joined
-- companies row (migration t25_esp_filter_v2...), because referencing that
-- row stopped Postgres removing the join and made the no-filter call about
-- 60x slower. It relies on the index below. person_push_status_counts keeps
-- the simpler joined-row form (t25_esp_filter_v3...): the id-set form timed
-- out there. Rollback also needs: DROP INDEX CONCURRENTLY companies_mx_provider_id_idx;
--
-- Fix applied the same day (migration t25_esp_filter_v5_people_plpgsql_custom_plan):
-- people_matching_virtual_filters is now LANGUAGE plpgsql with
-- SET plan_cache_mode = force_custom_plan, and RETURN QUERY runs the same query
-- as before. PostgREST passes `filters` as a runtime value, so the sql body was
-- always planned generically and nothing folded: ESP filters timed out (30s+)
-- and the push filter took about 11s. Planned per call with the value, ESP
-- calls take 0.1-0.3s and the push filter 0.2s, with identical id sets. The
-- rollback file needs no change: CREATE OR REPLACE there resets language and SET.

CREATE INDEX CONCURRENTLY IF NOT EXISTS companies_mx_provider_id_idx ON public.companies (mx_provider, id);

CREATE OR REPLACE FUNCTION public.people_matching_virtual_filters(filters jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(id uuid)
 LANGUAGE plpgsql
 STABLE
 SET plan_cache_mode TO 'force_custom_plan'
AS $function$
#variable_conflict use_column
BEGIN
  -- Ticket #25 fix: plpgsql + force_custom_plan so the query below is planned
  -- per call with the actual `filters` value. PostgREST passes filters as a
  -- runtime value (json_to_record over the request body), so the old LANGUAGE
  -- sql body was always planned generically: no filter branch folded away,
  -- the companies join ran once per person (about 14s with no ESP, 30s+
  -- timeouts with one). Planned with the value, the no-ESP branches fold as
  -- designed and the ESP id sets are hashed. The query is unchanged.
  RETURN QUERY
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
      -- Push-status filter (ticket #127), extracted once here (not re-dug per
      -- use site). `pushStatus` absent or inactive (JSON null) -> all three are
      -- NULL -> the predicate's CASE falls to ELSE true, a no-op byte-identical
      -- to pre-#127 behavior. Present -> {clientId, platform, status}; clientId
      -- is cast cast-safe via safe_uuid (URL-supplied, only "non-empty"-checked
      -- upstream, so it must not throw — see safe_uuid).
      filters#>>'{pushStatus,status}' AS push_status_kind,
      filters#>>'{pushStatus,platform}' AS push_platform,
      safe_uuid(filters#>>'{pushStatus,clientId}') AS push_client_id,
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
  -- Ticket #25: ids of the companies with an included / excluded ESP. People
  -- have no ESP of their own, so the filter matches company_id against these
  -- sets (hashed once, via companies_mx_provider_id_idx). The ESP arrays are
  -- read from `filters` directly, not from params or the joined companies
  -- row: either would stop Postgres folding the no-ESP case away, and the
  -- no-filter call would then probe companies once per person.
  mx_inc_companies AS (
    SELECT c2.id FROM companies c2 WHERE c2.mx_provider = ANY(translate(COALESCE(filters#>>'{mxProvider,include}', '[]'), '[]" ', '{}')::text[])
  ),
  mx_exc_companies AS (
    SELECT c2.id FROM companies c2 WHERE c2.mx_provider = ANY(translate(COALESCE(filters#>>'{mxProvider,exclude}', '[]'), '[]" ', '{}')::text[])
  )
  -- Ticket #30: LEFT JOIN (not INNER) so a person with no linked company
  -- (company_id NULL) still evaluates person-sourced conditions correctly —
  -- a company-sourced condition then reads co.custom_data as NULL, which
  -- virtual_filter_predicate_matches treats as no match, the correct outcome.
  SELECT p.id
  FROM people p LEFT JOIN companies co ON co.id = p.company_id, params pr
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
    AND (jsonb_array_length(COALESCE(filters#>'{mxProvider,exclude}', '[]'::jsonb)) = 0 OR p.company_id IS NULL OR NOT (p.company_id IN (SELECT id FROM mx_exc_companies)))
    AND (jsonb_array_length(COALESCE(filters#>'{mxProvider,include}', '[]'::jsonb)) = 0 OR p.company_id IN (SELECT id FROM mx_inc_companies))
    -- Grouped virtual-filter fold (ticket #117) — identical to the companies
    -- copy above; keep in lockstep with all six inlined copies.
    --
    -- Ticket #30: each leaf is a per-condition dispatch. Absent source (or
    -- 'person') keeps the pre-#30 behavior byte-identical (ELSE branch).
    -- 'source' = 'company' reads the LEFT-JOINed co.custom_data instead —
    -- people->company is one-to-one via company_id, so no quantifier is
    -- needed (unlike the company->people fan-out above).
    AND (
      COALESCE(jsonb_array_length(pr.virtual_filters->'groups'), 0) = 0
      OR CASE WHEN COALESCE(pr.virtual_filters->>'combinator', 'and') = 'or' THEN
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(pr.virtual_filters->'groups') AS grp
          WHERE CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
              EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                      WHERE (CASE
                        WHEN COALESCE(cond->>'source','person') = 'company' THEN virtual_filter_predicate_matches(co.custom_data, cond)
                        ELSE virtual_filter_predicate_matches(p.custom_data, cond)
                        END))
            ELSE
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                          WHERE NOT (CASE
                            WHEN COALESCE(cond->>'source','person') = 'company' THEN virtual_filter_predicate_matches(co.custom_data, cond)
                            ELSE virtual_filter_predicate_matches(p.custom_data, cond)
                            END))
            END
        )
      ELSE
        NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(pr.virtual_filters->'groups') AS grp
          WHERE NOT (CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
              EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                      WHERE (CASE
                        WHEN COALESCE(cond->>'source','person') = 'company' THEN virtual_filter_predicate_matches(co.custom_data, cond)
                        ELSE virtual_filter_predicate_matches(p.custom_data, cond)
                        END))
            ELSE
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                          WHERE NOT (CASE
                            WHEN COALESCE(cond->>'source','person') = 'company' THEN virtual_filter_predicate_matches(co.custom_data, cond)
                            ELSE virtual_filter_predicate_matches(p.custom_data, cond)
                            END))
            END)
        )
      END
    )
    -- Push-status filter (ticket #127) — keep in lockstep with the same clause
    -- in person_filter_options' base CTE (people-canonical-columns.sql).
    -- pushed: person has a push row for this client/platform; not_pushed: none.
    -- Absent/inactive filter -> push_status_kind NULL -> ELSE true (byte-identical
    -- to pre-#127). Inlined semi/anti-join so
    -- platform_pushes_client_platform_person_idx is used.
    AND CASE pr.push_status_kind
      WHEN 'pushed' THEN EXISTS (
        SELECT 1 FROM platform_pushes pp
        WHERE pp.person_id = p.id
          AND pp.client_id = pr.push_client_id
          AND pp.platform = pr.push_platform
      )
      WHEN 'not_pushed' THEN NOT EXISTS (
        SELECT 1 FROM platform_pushes pp
        WHERE pp.person_id = p.id
          AND pp.client_id = pr.push_client_id
          AND pp.platform = pr.push_platform
      )
      ELSE true
    END
  ORDER BY p.id;
END
$function$

CREATE OR REPLACE FUNCTION public.companies_matching_virtual_filters(filters jsonb DEFAULT '{}'::jsonb)
 RETURNS TABLE(id uuid)
 LANGUAGE sql
 STABLE
AS $function$
  WITH params AS (
    SELECT
      NULLIF(trim(both from (filters->>'search')), '') AS search,
      (filters->>'employeeMin')::int AS emp_min,
      (filters->>'employeeMax')::int AS emp_max,
      COALESCE(filters->'employeeBucketRanges', '[]'::jsonb) AS emp_ranges,
      COALESCE(filters->>'email', 'any') AS email_filter,
      COALESCE(filters->>'phone', 'any') AS phone_filter,
      COALESCE(filters->'virtualFilters', '{}'::jsonb) AS virtual_filters,
      filters#>>'{pushStatus,status}' AS push_status_kind,
      filters#>>'{pushStatus,platform}' AS push_platform,
      safe_uuid(filters#>>'{pushStatus,clientId}') AS push_client_id,
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
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{phoneType,exclude}', '[]'::jsonb))) AS phonetype_exc,
      -- Ticket #25: ESP (companies.mx_provider) include/exclude.
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{mxProvider,include}', '[]'::jsonb))) AS mxprovider_inc,
      ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{mxProvider,exclude}', '[]'::jsonb))) AS mxprovider_exc
  ),
  -- Forces Postgres to build this result set on its own before the outer
  -- ORDER BY is applied, instead of walking companies_pkey in id order
  -- (see lib/data/hotfix-companies-rpc-materialize.sql).
  matched AS MATERIALIZED (
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
      AND (cardinality(p.mxprovider_exc) = 0 OR c.mx_provider IS NULL OR NOT (c.mx_provider = ANY(p.mxprovider_exc)))
      AND (cardinality(p.mxprovider_inc) = 0 OR c.mx_provider = ANY(p.mxprovider_inc))
      AND (
        COALESCE(jsonb_array_length(p.virtual_filters->'groups'), 0) = 0
        OR CASE WHEN COALESCE(p.virtual_filters->>'combinator', 'and') = 'or' THEN
          EXISTS (
            SELECT 1 FROM jsonb_array_elements(p.virtual_filters->'groups') AS grp
            WHERE CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
                EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                        WHERE (CASE
                          WHEN COALESCE(cond->>'source','company') = 'person' THEN
                            CASE WHEN COALESCE(cond->>'quantifier','any') = 'all' THEN
                              EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id)
                              AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND NOT virtual_filter_predicate_matches(pe.custom_data, cond))
                            ELSE
                              EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND virtual_filter_predicate_matches(pe.custom_data, cond))
                            END
                          ELSE
                            virtual_filter_predicate_matches(c.custom_data, cond)
                          END))
              ELSE
                NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                            WHERE NOT (CASE
                              WHEN COALESCE(cond->>'source','company') = 'person' THEN
                                CASE WHEN COALESCE(cond->>'quantifier','any') = 'all' THEN
                                  EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id)
                                  AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND NOT virtual_filter_predicate_matches(pe.custom_data, cond))
                                ELSE
                                  EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND virtual_filter_predicate_matches(pe.custom_data, cond))
                                END
                              ELSE
                                virtual_filter_predicate_matches(c.custom_data, cond)
                              END))
              END
          )
        ELSE
          NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements(p.virtual_filters->'groups') AS grp
            WHERE NOT (CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
                EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                        WHERE (CASE
                          WHEN COALESCE(cond->>'source','company') = 'person' THEN
                            CASE WHEN COALESCE(cond->>'quantifier','any') = 'all' THEN
                              EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id)
                              AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND NOT virtual_filter_predicate_matches(pe.custom_data, cond))
                            ELSE
                              EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND virtual_filter_predicate_matches(pe.custom_data, cond))
                            END
                          ELSE
                            virtual_filter_predicate_matches(c.custom_data, cond)
                          END))
              ELSE
                NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                            WHERE NOT (CASE
                              WHEN COALESCE(cond->>'source','company') = 'person' THEN
                                CASE WHEN COALESCE(cond->>'quantifier','any') = 'all' THEN
                                  EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id)
                                  AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND NOT virtual_filter_predicate_matches(pe.custom_data, cond))
                                ELSE
                                  EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND virtual_filter_predicate_matches(pe.custom_data, cond))
                                END
                              ELSE
                                virtual_filter_predicate_matches(c.custom_data, cond)
                              END))
              END)
          )
        END
      )
      AND CASE p.push_status_kind
        WHEN 'not_pushed' THEN EXISTS (
          SELECT 1 FROM people pe
          WHERE pe.company_id = c.id
            AND NOT EXISTS (
              SELECT 1 FROM platform_pushes pp
              WHERE pp.person_id = pe.id
                AND pp.client_id = p.push_client_id
                AND pp.platform = p.push_platform
            )
        )
        WHEN 'pushed' THEN
          EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id)
          AND NOT EXISTS (
            SELECT 1 FROM people pe
            WHERE pe.company_id = c.id
              AND NOT EXISTS (
                SELECT 1 FROM platform_pushes pp
                WHERE pp.person_id = pe.id
                  AND pp.client_id = p.push_client_id
                  AND pp.platform = p.push_platform
              )
          )
        ELSE true
      END
  )
  SELECT matched.id FROM matched ORDER BY matched.id
$function$

CREATE OR REPLACE FUNCTION public.person_filter_options(filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
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
    -- Push-status filter (ticket #127), extracted once — clientId cast cast-safe
    -- via safe_uuid (virtual-columns.sql). Absent/inactive -> all NULL -> no-op.
    filters#>>'{pushStatus,status}' AS push_status_kind,
    filters#>>'{pushStatus,platform}' AS push_platform,
    safe_uuid(filters#>>'{pushStatus,clientId}') AS push_client_id,
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
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{phoneType,exclude}', '[]'::jsonb))) AS phonetype_exc,
    -- Ticket #25: ESP (companies.mx_provider) include/exclude.
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{mxProvider,include}', '[]'::jsonb))) AS mxprovider_inc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{mxProvider,exclude}', '[]'::jsonb))) AS mxprovider_exc
),
-- MATERIALIZED forces one scan of `people`, reused by all six facet
-- subqueries below instead of six independent scans.
base AS MATERIALIZED (
  -- Ticket #30: LEFT JOIN so a person with no linked company (company_id
  -- NULL) still evaluates person-sourced conditions correctly, mirroring
  -- people_matching_virtual_filters (virtual-columns.sql).
  SELECT co.mx_provider AS mx_provider, p.niche_tokens, p.industry_id, p.country_id, p.source_tokens,
         p.employee_count, p.email_status, p.phone_type, p.email, p.phone, p.job_title
  FROM people p LEFT JOIN companies co ON co.id = p.company_id, params pr
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
    --
    -- Ticket #30: per-condition dispatch — a company-sourced condition
    -- ('source' = 'company') reads the LEFT-JOINed co.custom_data; absent
    -- source (or 'person') is byte-identical to pre-#30 behavior. People->
    -- company is one-to-one, so no quantifier is needed here (unlike the
    -- company->people fan-out in canonical-columns.sql).
    AND (
      COALESCE(jsonb_array_length(pr.virtual_filters->'groups'), 0) = 0
      OR CASE WHEN COALESCE(pr.virtual_filters->>'combinator', 'and') = 'or' THEN
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(pr.virtual_filters->'groups') AS grp
          WHERE CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
              EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                      WHERE (CASE
                        WHEN COALESCE(cond->>'source','person') = 'company' THEN virtual_filter_predicate_matches(co.custom_data, cond)
                        ELSE virtual_filter_predicate_matches(p.custom_data, cond)
                        END))
            ELSE
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                          WHERE NOT (CASE
                            WHEN COALESCE(cond->>'source','person') = 'company' THEN virtual_filter_predicate_matches(co.custom_data, cond)
                            ELSE virtual_filter_predicate_matches(p.custom_data, cond)
                            END))
            END
        )
      ELSE
        NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(pr.virtual_filters->'groups') AS grp
          WHERE NOT (CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
              EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                      WHERE (CASE
                        WHEN COALESCE(cond->>'source','person') = 'company' THEN virtual_filter_predicate_matches(co.custom_data, cond)
                        ELSE virtual_filter_predicate_matches(p.custom_data, cond)
                        END))
            ELSE
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                          WHERE NOT (CASE
                            WHEN COALESCE(cond->>'source','person') = 'company' THEN virtual_filter_predicate_matches(co.custom_data, cond)
                            ELSE virtual_filter_predicate_matches(p.custom_data, cond)
                            END))
            END)
        )
      END
    )
    -- Push-status filter (ticket #127) — identical to the clause in
    -- people_matching_virtual_filters (virtual-columns.sql); keep in lockstep so
    -- the six facet counts stay scoped to the same rows the list returns.
    AND CASE pr.push_status_kind
      WHEN 'pushed' THEN EXISTS (
        SELECT 1 FROM platform_pushes pp
        WHERE pp.person_id = p.id
          AND pp.client_id = pr.push_client_id
          AND pp.platform = pr.push_platform
      )
      WHEN 'not_pushed' THEN NOT EXISTS (
        SELECT 1 FROM platform_pushes pp
        WHERE pp.person_id = p.id
          AND pp.client_id = pr.push_client_id
          AND pp.platform = pr.push_platform
      )
      ELSE true
    END
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
      AND (cardinality(params.mxprovider_exc) = 0 OR base.mx_provider IS NULL OR NOT (base.mx_provider = ANY(params.mxprovider_exc)))
      AND (cardinality(params.mxprovider_inc) = 0 OR base.mx_provider = ANY(params.mxprovider_inc))
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
      AND (cardinality(params.mxprovider_exc) = 0 OR base.mx_provider IS NULL OR NOT (base.mx_provider = ANY(params.mxprovider_exc)))
      AND (cardinality(params.mxprovider_inc) = 0 OR base.mx_provider = ANY(params.mxprovider_inc))
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
    AND (cardinality(params.mxprovider_exc) = 0 OR base.mx_provider IS NULL OR NOT (base.mx_provider = ANY(params.mxprovider_exc)))
    AND (cardinality(params.mxprovider_inc) = 0 OR base.mx_provider = ANY(params.mxprovider_inc))
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
    AND (cardinality(params.mxprovider_exc) = 0 OR base.mx_provider IS NULL OR NOT (base.mx_provider = ANY(params.mxprovider_exc)))
    AND (cardinality(params.mxprovider_inc) = 0 OR base.mx_provider = ANY(params.mxprovider_inc))
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
    AND (cardinality(params.mxprovider_exc) = 0 OR base.mx_provider IS NULL OR NOT (base.mx_provider = ANY(params.mxprovider_exc)))
    AND (cardinality(params.mxprovider_inc) = 0 OR base.mx_provider = ANY(params.mxprovider_inc))
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
    AND (cardinality(params.mxprovider_exc) = 0 OR base.mx_provider IS NULL OR NOT (base.mx_provider = ANY(params.mxprovider_exc)))
    AND (cardinality(params.mxprovider_inc) = 0 OR base.mx_provider = ANY(params.mxprovider_inc))
  GROUP BY base.phone_type
),
-- Ticket #25: ESP facet. Scoped by every other filter, never by itself.
mx_providers AS (
  SELECT base.mx_provider AS id, count(*) AS count FROM base, params
  WHERE base.mx_provider IS NOT NULL AND base.mx_provider <> ''
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
  GROUP BY base.mx_provider
)
SELECT jsonb_build_object(
  'niches', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM niches), '[]'::jsonb),
  'sources', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM sources), '[]'::jsonb),
  'industries', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM industries), '[]'::jsonb),
  'countries', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM countries), '[]'::jsonb),
  'emailStatuses', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM email_statuses), '[]'::jsonb),
  'phoneTypes', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM phone_types), '[]'::jsonb),
  'mxProviders', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM mx_providers), '[]'::jsonb)
);
$function$

CREATE OR REPLACE FUNCTION public.company_filter_options(filters jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
WITH params AS (
  SELECT
    NULLIF(trim(both from (filters->>'search')), '') AS search,
    (filters->>'employeeMin')::int AS emp_min,
    (filters->>'employeeMax')::int AS emp_max,
    COALESCE(filters->'employeeBucketRanges', '[]'::jsonb) AS emp_ranges,
    COALESCE(filters->>'email', 'any') AS email_filter,
    COALESCE(filters->>'phone', 'any') AS phone_filter,
    COALESCE(filters->'virtualFilters', '{}'::jsonb) AS virtual_filters,
    -- Push-status filter (ticket #127), extracted once — clientId cast cast-safe
    -- via safe_uuid (virtual-columns.sql). Absent/inactive -> all NULL -> no-op.
    filters#>>'{pushStatus,status}' AS push_status_kind,
    filters#>>'{pushStatus,platform}' AS push_platform,
    safe_uuid(filters#>>'{pushStatus,clientId}') AS push_client_id,
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
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{phoneType,exclude}', '[]'::jsonb))) AS phonetype_exc,
    -- Ticket #25: ESP (companies.mx_provider) include/exclude.
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{mxProvider,include}', '[]'::jsonb))) AS mxprovider_inc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{mxProvider,exclude}', '[]'::jsonb))) AS mxprovider_exc
),
-- MATERIALIZED forces one scan of `companies`, reused by all six facet
-- subqueries below instead of six independent scans.
base AS MATERIALIZED (
  SELECT c.mx_provider AS mx_provider, c.niche, c.industry_id, c.country_id, c.source_tokens, c.email_status, c.phone_type
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
    -- Grouped virtual-filter fold (ticket #117) — identical to the copies in
    -- virtual-columns.sql and enrichment-fields.sql; keep all six in lockstep
    -- or the facet counts diverge from the list (the #37 class of bug).
    --
    -- Ticket #30: per-condition dispatch — a person-sourced condition
    -- ('source' = 'person') reads this company's linked people instead of
    -- c.custom_data; see companies_matching_virtual_filters (virtual-columns.sql)
    -- for the full comment on the any/all quantifier semantics. Absent source
    -- (or 'company') is byte-identical to pre-#30 behavior.
    AND (
      COALESCE(jsonb_array_length(p.virtual_filters->'groups'), 0) = 0
      OR CASE WHEN COALESCE(p.virtual_filters->>'combinator', 'and') = 'or' THEN
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(p.virtual_filters->'groups') AS grp
          WHERE CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
              EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                      WHERE (CASE
                        WHEN COALESCE(cond->>'source','company') = 'person' THEN
                          CASE WHEN COALESCE(cond->>'quantifier','any') = 'all' THEN
                            EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id)
                            AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND NOT virtual_filter_predicate_matches(pe.custom_data, cond))
                          ELSE
                            EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND virtual_filter_predicate_matches(pe.custom_data, cond))
                          END
                        ELSE
                          virtual_filter_predicate_matches(c.custom_data, cond)
                        END))
            ELSE
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                          WHERE NOT (CASE
                            WHEN COALESCE(cond->>'source','company') = 'person' THEN
                              CASE WHEN COALESCE(cond->>'quantifier','any') = 'all' THEN
                                EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id)
                                AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND NOT virtual_filter_predicate_matches(pe.custom_data, cond))
                              ELSE
                                EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND virtual_filter_predicate_matches(pe.custom_data, cond))
                              END
                            ELSE
                              virtual_filter_predicate_matches(c.custom_data, cond)
                            END))
            END
        )
      ELSE
        NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(p.virtual_filters->'groups') AS grp
          WHERE NOT (CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
              EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                      WHERE (CASE
                        WHEN COALESCE(cond->>'source','company') = 'person' THEN
                          CASE WHEN COALESCE(cond->>'quantifier','any') = 'all' THEN
                            EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id)
                            AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND NOT virtual_filter_predicate_matches(pe.custom_data, cond))
                          ELSE
                            EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND virtual_filter_predicate_matches(pe.custom_data, cond))
                          END
                        ELSE
                          virtual_filter_predicate_matches(c.custom_data, cond)
                        END))
            ELSE
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                          WHERE NOT (CASE
                            WHEN COALESCE(cond->>'source','company') = 'person' THEN
                              CASE WHEN COALESCE(cond->>'quantifier','any') = 'all' THEN
                                EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id)
                                AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND NOT virtual_filter_predicate_matches(pe.custom_data, cond))
                              ELSE
                                EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND virtual_filter_predicate_matches(pe.custom_data, cond))
                              END
                            ELSE
                              virtual_filter_predicate_matches(c.custom_data, cond)
                            END))
            END)
        )
      END
    )
    -- Push-status filter (ticket #127), company "has work left" semantics —
    -- identical to companies_matching_virtual_filters (virtual-columns.sql);
    -- keep in lockstep so facet counts match the list.
    AND CASE p.push_status_kind
      WHEN 'not_pushed' THEN EXISTS (
        SELECT 1 FROM people pe
        WHERE pe.company_id = c.id
          AND NOT EXISTS (
            SELECT 1 FROM platform_pushes pp
            WHERE pp.person_id = pe.id
              AND pp.client_id = p.push_client_id
              AND pp.platform = p.push_platform
          )
      )
      WHEN 'pushed' THEN
        EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id)
        AND NOT EXISTS (
          SELECT 1 FROM people pe
          WHERE pe.company_id = c.id
            AND NOT EXISTS (
              SELECT 1 FROM platform_pushes pp
              WHERE pp.person_id = pe.id
                AND pp.client_id = p.push_client_id
                AND pp.platform = p.push_platform
            )
        )
      ELSE true
    END
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
    AND (cardinality(params.mxprovider_exc) = 0 OR base.mx_provider IS NULL OR NOT (base.mx_provider = ANY(params.mxprovider_exc)))
    AND (cardinality(params.mxprovider_inc) = 0 OR base.mx_provider = ANY(params.mxprovider_inc))
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
      AND (cardinality(params.mxprovider_exc) = 0 OR base.mx_provider IS NULL OR NOT (base.mx_provider = ANY(params.mxprovider_exc)))
      AND (cardinality(params.mxprovider_inc) = 0 OR base.mx_provider = ANY(params.mxprovider_inc))
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
    AND (cardinality(params.mxprovider_exc) = 0 OR base.mx_provider IS NULL OR NOT (base.mx_provider = ANY(params.mxprovider_exc)))
    AND (cardinality(params.mxprovider_inc) = 0 OR base.mx_provider = ANY(params.mxprovider_inc))
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
    AND (cardinality(params.mxprovider_exc) = 0 OR base.mx_provider IS NULL OR NOT (base.mx_provider = ANY(params.mxprovider_exc)))
    AND (cardinality(params.mxprovider_inc) = 0 OR base.mx_provider = ANY(params.mxprovider_inc))
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
    AND (cardinality(params.mxprovider_exc) = 0 OR base.mx_provider IS NULL OR NOT (base.mx_provider = ANY(params.mxprovider_exc)))
    AND (cardinality(params.mxprovider_inc) = 0 OR base.mx_provider = ANY(params.mxprovider_inc))
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
    AND (cardinality(params.mxprovider_exc) = 0 OR base.mx_provider IS NULL OR NOT (base.mx_provider = ANY(params.mxprovider_exc)))
    AND (cardinality(params.mxprovider_inc) = 0 OR base.mx_provider = ANY(params.mxprovider_inc))
  GROUP BY base.phone_type
),
-- Ticket #25: ESP facet. Scoped by every other filter, never by itself.
mx_providers AS (
  SELECT base.mx_provider AS id, count(*) AS count FROM base, params
  WHERE base.mx_provider IS NOT NULL AND base.mx_provider <> ''
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
    AND (cardinality(params.phonetype_exc) = 0 OR base.phone_type IS NULL OR NOT (base.phone_type = ANY(params.phonetype_exc)))
    AND (cardinality(params.phonetype_inc) = 0 OR base.phone_type = ANY(params.phonetype_inc))
  GROUP BY base.mx_provider
)
SELECT jsonb_build_object(
  'niches', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM niches), '[]'::jsonb),
  'sources', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM sources), '[]'::jsonb),
  'industries', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM industries), '[]'::jsonb),
  'countries', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM countries), '[]'::jsonb),
  'emailStatuses', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM email_statuses), '[]'::jsonb),
  'phoneTypes', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM phone_types), '[]'::jsonb),
  'mxProviders', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM mx_providers), '[]'::jsonb)
);
$function$

CREATE OR REPLACE FUNCTION public.person_push_status_counts(filters jsonb DEFAULT '{}'::jsonb, client_id uuid DEFAULT NULL::uuid, platform text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
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
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{phoneType,exclude}', '[]'::jsonb))) AS phonetype_exc,
    -- Ticket #25: ESP (companies.mx_provider) include/exclude.
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{mxProvider,include}', '[]'::jsonb))) AS mxprovider_inc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{mxProvider,exclude}', '[]'::jsonb))) AS mxprovider_exc
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
  -- Ticket #30: LEFT JOIN so a person with no linked company still
  -- evaluates person-sourced conditions correctly, mirroring
  -- people_matching_virtual_filters (virtual-columns.sql).
  FROM people p LEFT JOIN companies co ON co.id = p.company_id, params pr
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
    --
    -- Ticket #30: per-condition dispatch, identical to person_filter_options
    -- (people-canonical-columns.sql) — a company-sourced condition reads the
    -- LEFT-JOINed co.custom_data.
    AND (
      COALESCE(jsonb_array_length(pr.virtual_filters->'groups'), 0) = 0
      OR CASE WHEN COALESCE(pr.virtual_filters->>'combinator', 'and') = 'or' THEN
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(pr.virtual_filters->'groups') AS grp
          WHERE CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
              EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                      WHERE (CASE
                        WHEN COALESCE(cond->>'source','person') = 'company' THEN virtual_filter_predicate_matches(co.custom_data, cond)
                        ELSE virtual_filter_predicate_matches(p.custom_data, cond)
                        END))
            ELSE
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                          WHERE NOT (CASE
                            WHEN COALESCE(cond->>'source','person') = 'company' THEN virtual_filter_predicate_matches(co.custom_data, cond)
                            ELSE virtual_filter_predicate_matches(p.custom_data, cond)
                            END))
            END
        )
      ELSE
        NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(pr.virtual_filters->'groups') AS grp
          WHERE NOT (CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
              EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                      WHERE (CASE
                        WHEN COALESCE(cond->>'source','person') = 'company' THEN virtual_filter_predicate_matches(co.custom_data, cond)
                        ELSE virtual_filter_predicate_matches(p.custom_data, cond)
                        END))
            ELSE
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                          WHERE NOT (CASE
                            WHEN COALESCE(cond->>'source','person') = 'company' THEN virtual_filter_predicate_matches(co.custom_data, cond)
                            ELSE virtual_filter_predicate_matches(p.custom_data, cond)
                            END))
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
    AND (cardinality(pr.mxprovider_exc) = 0 OR co.mx_provider IS NULL OR NOT (co.mx_provider = ANY(pr.mxprovider_exc)))
    AND (cardinality(pr.mxprovider_inc) = 0 OR co.mx_provider = ANY(pr.mxprovider_inc))
)
SELECT jsonb_build_object(
  'pushed', COALESCE(count(*) FILTER (WHERE is_pushed), 0),
  'notPushed', COALESCE(count(*) FILTER (WHERE NOT is_pushed), 0)
) FROM scoped;
$function$

CREATE OR REPLACE FUNCTION public.company_push_status_counts(filters jsonb DEFAULT '{}'::jsonb, client_id uuid DEFAULT NULL::uuid, platform text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
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
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{phoneType,exclude}', '[]'::jsonb))) AS phonetype_exc,
    -- Ticket #25: ESP (companies.mx_provider) include/exclude.
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{mxProvider,include}', '[]'::jsonb))) AS mxprovider_inc,
    ARRAY(SELECT jsonb_array_elements_text(COALESCE(filters#>'{mxProvider,exclude}', '[]'::jsonb))) AS mxprovider_exc
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
    -- Ticket #30: per-condition dispatch, identical to company_filter_options
    -- (canonical-columns.sql) — a person-sourced condition reads this
    -- company's linked people.
    AND (
      COALESCE(jsonb_array_length(pr.virtual_filters->'groups'), 0) = 0
      OR CASE WHEN COALESCE(pr.virtual_filters->>'combinator', 'and') = 'or' THEN
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(pr.virtual_filters->'groups') AS grp
          WHERE CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
              EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                      WHERE (CASE
                        WHEN COALESCE(cond->>'source','company') = 'person' THEN
                          CASE WHEN COALESCE(cond->>'quantifier','any') = 'all' THEN
                            EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id)
                            AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND NOT virtual_filter_predicate_matches(pe.custom_data, cond))
                          ELSE
                            EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND virtual_filter_predicate_matches(pe.custom_data, cond))
                          END
                        ELSE
                          virtual_filter_predicate_matches(c.custom_data, cond)
                        END))
            ELSE
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                          WHERE NOT (CASE
                            WHEN COALESCE(cond->>'source','company') = 'person' THEN
                              CASE WHEN COALESCE(cond->>'quantifier','any') = 'all' THEN
                                EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id)
                                AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND NOT virtual_filter_predicate_matches(pe.custom_data, cond))
                              ELSE
                                EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND virtual_filter_predicate_matches(pe.custom_data, cond))
                              END
                            ELSE
                              virtual_filter_predicate_matches(c.custom_data, cond)
                            END))
            END
        )
      ELSE
        NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(pr.virtual_filters->'groups') AS grp
          WHERE NOT (CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
              EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                      WHERE (CASE
                        WHEN COALESCE(cond->>'source','company') = 'person' THEN
                          CASE WHEN COALESCE(cond->>'quantifier','any') = 'all' THEN
                            EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id)
                            AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND NOT virtual_filter_predicate_matches(pe.custom_data, cond))
                          ELSE
                            EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND virtual_filter_predicate_matches(pe.custom_data, cond))
                          END
                        ELSE
                          virtual_filter_predicate_matches(c.custom_data, cond)
                        END))
            ELSE
              NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                          WHERE NOT (CASE
                            WHEN COALESCE(cond->>'source','company') = 'person' THEN
                              CASE WHEN COALESCE(cond->>'quantifier','any') = 'all' THEN
                                EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id)
                                AND NOT EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND NOT virtual_filter_predicate_matches(pe.custom_data, cond))
                              ELSE
                                EXISTS (SELECT 1 FROM people pe WHERE pe.company_id = c.id AND virtual_filter_predicate_matches(pe.custom_data, cond))
                              END
                            ELSE
                              virtual_filter_predicate_matches(c.custom_data, cond)
                            END))
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
    AND (cardinality(pr.mxprovider_exc) = 0 OR c.mx_provider IS NULL OR NOT (c.mx_provider = ANY(pr.mxprovider_exc)))
    AND (cardinality(pr.mxprovider_inc) = 0 OR c.mx_provider = ANY(pr.mxprovider_inc))
)
SELECT jsonb_build_object(
  -- not_pushed == has work left; pushed == has people AND no work left.
  'notPushed', COALESCE(count(*) FILTER (WHERE has_work_left), 0),
  'pushed', COALESCE(count(*) FILTER (WHERE has_people AND NOT has_work_left), 0)
) FROM scoped;
$function$

