-- HOTFIX: public.companies_matching_virtual_filters -- wrap the predicate in
-- a MATERIALIZED CTE so the ORDER BY happens after the row set is built,
-- not while it's being built.
--
-- Cause: the function ends in `ORDER BY c.id`, and the caller pages the
-- result with `.range()`, so that order must be preserved. But with the
-- predicate and the ORDER BY in the same query, the planner satisfies the
-- sort by walking `companies_pkey` in UUID order and re-checking the
-- predicate per row -- on a 418 MB table (305k rows) with shared_buffers at
-- 256 MB, that's a stream of random heap fetches that miss cache constantly.
-- That plan takes ~40s. The same predicate evaluated as a plain seq scan
-- (no index-order walk) takes ~4s.
--
-- Fix: compute the matching ids in a MATERIALIZED CTE first (forces
-- Postgres to build that intermediate result set with a seq scan, since
-- nothing inside the CTE needs c.id order), then sort the small materialized
-- set by id afterward. Signature, volatility (STABLE), and the predicate
-- itself are byte-identical to the current live definition -- only the
-- query shape changes, from "scan in id order while filtering" to "filter,
-- then sort the results by id".
--
-- Applied to production 2026-09-28 (migration companies_rpc_materialize_matched_ids).
-- hotfix-companies-rpc-materialize-rollback.sql
-- restores the current live definition if this needs to be reverted.

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
      -- Push-status filter (ticket #127), extracted once here (not re-dug per
      -- use site). `pushStatus` absent or inactive (JSON null) -> all three are
      -- NULL -> the predicate's CASE falls to ELSE true, a no-op byte-identical
      -- to pre-#127 behavior. Present -> {clientId, platform, status}; clientId
      -- is cast cast-safe via safe_uuid (URL-supplied, only "non-empty"-checked
      -- upstream, so it must not throw -- see safe_uuid).
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
  -- Forces Postgres to build this result set on its own before the outer
  -- ORDER BY is applied. Without MATERIALIZED the planner can (and does)
  -- pull the ORDER BY down into this subquery and satisfy it by walking
  -- companies_pkey in id order -- see the header comment above.
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
      -- Grouped virtual-filter fold (ticket #117), inlined per the perf note on
      -- virtual_filters_match -- must stay in lockstep with the identical fold in
      -- people_matching_virtual_filters, company_filter_options /
      -- person_filter_options, and company_enrichment_fields /
      -- person_enrichment_fields (grep virtual_filter_predicate_matches).
      --
      -- Ticket #30 (symmetric cross-table enrichment filtering): each leaf call
      -- is a per-condition dispatch on `cond->>'source'` rather than a bare
      -- virtual_filter_predicate_matches(c.custom_data, cond) call. Absent
      -- source (or 'company') keeps the pre-#30 behavior byte-identical
      -- (ELSE branch). A person-sourced condition ('source' = 'person')
      -- evaluates over this company's linked people instead: 'any' matches if
      -- at least one linked person satisfies the leaf (correlated EXISTS,
      -- mirroring the push-status EXISTS pattern below); 'all' matches if the
      -- company has >=1 linked person (leading EXISTS guard, so a zero-people
      -- company never matches an "all" cross-table condition) AND no linked
      -- person fails the leaf (NOT EXISTS ... NOT ..., mirroring the AND-fold's
      -- own NOT EXISTS shape one level up). Still no SubLink-free requirement
      -- here: this whole dispatch is itself inside an EXISTS/NOT EXISTS already,
      -- so it doesn't need to individually inline -- only the leaf
      -- virtual_filter_predicate_matches call (unchanged, still the one
      -- inlinable primitive) matters for perf.
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
      -- Push-status filter (ticket #127), company "has work left" semantics --
      -- keep in lockstep with company_filter_options' base CTE (canonical-columns.sql).
      -- not_pushed: >=1 linked person NOT yet pushed to this client/platform.
      -- pushed: has >=1 linked person AND none of them is un-pushed (every linked
      -- person already pushed). Absent/inactive filter -> push_status_kind NULL ->
      -- ELSE true (no-op). Inlined EXISTS/NOT EXISTS (not a wrapper fn) so the
      -- planner can use platform_pushes_client_platform_person_idx instead of an
      -- opaque per-row call.
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
$function$;
