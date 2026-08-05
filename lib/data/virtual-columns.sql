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

-- Ticket #116 revised its first draft of the contains/not_contains chip-input
-- helpers mid-review (a nested CASE inside text_filter_matches/list_filter_matches
-- knocked those functions off Postgres's inliner — see text_contains_matches'
-- comment below) — drop the earlier names so a re-run of this file doesn't
-- leave them behind as orphaned, unused functions.
DROP FUNCTION IF EXISTS text_contains_any(text, jsonb);
DROP FUNCTION IF EXISTS list_contains_any(jsonb, jsonb);

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
-- Rewritten (ticket #34 perf fix), in two steps, both confirmed with
-- EXPLAIN/EXPLAIN ANALYZE against the live ~110k-row companies table:
--
-- 1. Dropped the original `WITH p AS (...), v AS (...) SELECT ... FROM p, v`
--    CTE shape in favor of inlining every `data -> (f->>'key')` /
--    `f->>'type'` etc. read directly. This didn't turn out to be the actual
--    bottleneck on its own (Postgres 12+ auto-inlines non-recursive CTEs
--    into the surrounding query by default, so the `WITH` wasn't the
--    problem the way older Postgres-versions' folklore says it would be) —
--    kept anyway since it's simpler and reads the same value only once per
--    branch.
-- 2. The real bottleneck: whether *this* function itself gets inlined by
--    Postgres's planner into whatever query calls it. Postgres's
--    `LANGUAGE sql` function inliner (`inline_function()`) will fold a
--    function's body directly into the caller's plan as a plain expression
--    — but only below some function-body complexity; empirically, the
--    original single function with 5 outer `f->>'type'` branches x ~5
--    operators each (~24 total WHEN arms across nested CASEs) was NOT
--    inlined (confirmed via EXPLAIN: it always showed up as an opaque
--    `virtual_filter_predicate_matches(c.custom_data, vf.value)` function
--    call in the Filter, never expanded), while smaller versions of the same
--    shape (fewer branches) *did* inline cleanly into a plain Join Filter
--    expression. A non-inlined function called once per row of a ~110k-row
--    scan pays real per-call overhead (confirmed: an equivalent raw
--    predicate with no function layer at all scans all ~110k rows in ~69ms;
--    the non-inlined-function version timed out past statement_timeout for
--    the 'is'/'contains' operators). The fix is to keep every individual
--    function small enough to inline: this function is now a thin dispatch
--    by `f->>'type'` to five per-type helper functions below
--    (text/number/boolean/list/date), each simple enough on its own to
--    inline (verified individually), and Postgres inlines recursively — a
--    thin dispatcher that only calls already-inlinable functions is itself
--    inlinable, so the whole chain collapses into one plain filter
--    expression with no function-call overhead left, exactly like the
--    smaller test cases. Semantics (types/operators/branches) are
--    unchanged, only decomposed into smaller pieces.
-- Chip-input dispatch helper for Text contains/not_contains (ticket #116):
-- true iff `text_value` ILIKE-matches the scalar `value`, or (when `value` is
-- a jsonb array — the chip input's stacked keywords) ILIKE-matches *any* of
-- its elements. Kept as its own function, called as a single flat FuncExpr
-- from each of text_filter_matches' 'contains'/'not_contains' arms, rather
-- than inlined as a *nested* CASE directly in text_filter_matches' own body:
-- empirically (EXPLAIN ANALYZE against the live ~146k-row companies table),
-- nesting a second CASE inside one arm was enough added branch complexity to
-- knock text_filter_matches itself off Postgres's inliner — it went from the
-- fully-inlined ~69ms-class scan every other operator here still gets to a
-- 9.4s opaque-function-call scan, matching this file's earlier "~24 WHEN arms
-- across nested CASEs was NOT inlined" finding above. Every arm in
-- text_filter_matches' CASE must stay a single flat expression the way it was
-- before this ticket; this function is where the array/scalar branching (and
-- the array case's inherently non-inlinable EXISTS subquery, reading a jsonb
-- array needs a FROM-clause SRF) lives instead.
CREATE OR REPLACE FUNCTION text_contains_matches(text_value text, value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'array' THEN EXISTS (
      SELECT 1 FROM jsonb_array_elements_text(value) AS kw
      WHERE text_value ILIKE ('%' || kw || '%')
    )
    ELSE text_value ILIKE ('%' || (value #>> '{}') || '%')
  END
$$;

CREATE OR REPLACE FUNCTION text_filter_matches(data jsonb, f jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE f->>'operator'
    -- 'is'/'is_not' accept either a scalar value or a JSON array of values
    -- (ticket #38's multi-select over a low-cardinality field's real distinct
    -- values). jsonb containment `@>` unifies both shapes: an array contains
    -- the row's value iff it matches any member, and — by Postgres's
    -- scalar-contains-equal-scalar rule — a scalar `@>` the row value is plain
    -- equality, so the single-value case keeps its exact prior semantics. The
    -- row value is coalesced to '' (missing key) so 'is_not' still includes a
    -- row that lacks the key, matching the pre-#38 `<>` behavior.
    WHEN 'is' THEN (f->'value') @> to_jsonb(COALESCE((data -> (f->>'key')) #>> '{}', ''))
    WHEN 'is_not' THEN NOT ((f->'value') @> to_jsonb(COALESCE((data -> (f->>'key')) #>> '{}', '')))
    -- 'contains'/'not_contains' additionally accept a JSON array of keywords
    -- (ticket #116's chip input): "matches any of" / "matches none of",
    -- delegated to text_contains_matches above (kept flat — see its comment).
    WHEN 'contains' THEN text_contains_matches(COALESCE((data -> (f->>'key')) #>> '{}', ''), f->'value')
    WHEN 'not_contains' THEN NOT text_contains_matches(COALESCE((data -> (f->>'key')) #>> '{}', ''), f->'value')
    WHEN 'is_empty' THEN is_empty_enrichment_value(data -> (f->>'key'))
    WHEN 'is_not_empty' THEN NOT is_empty_enrichment_value(data -> (f->>'key'))
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION number_filter_matches(data jsonb, f jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE f->>'operator'
    WHEN 'is' THEN enrichment_numeric(data -> (f->>'key')) IS NOT NULL AND enrichment_numeric(data -> (f->>'key')) = enrichment_numeric(f->'value')
    WHEN 'is_not' THEN enrichment_numeric(data -> (f->>'key')) IS NOT NULL AND enrichment_numeric(data -> (f->>'key')) <> enrichment_numeric(f->'value')
    WHEN 'gt' THEN enrichment_numeric(data -> (f->>'key')) IS NOT NULL AND enrichment_numeric(data -> (f->>'key')) > enrichment_numeric(f->'value')
    WHEN 'lt' THEN enrichment_numeric(data -> (f->>'key')) IS NOT NULL AND enrichment_numeric(data -> (f->>'key')) < enrichment_numeric(f->'value')
    WHEN 'between' THEN
      enrichment_numeric(data -> (f->>'key')) IS NOT NULL
      AND enrichment_numeric(data -> (f->>'key')) BETWEEN enrichment_numeric((f->'value')->0) AND enrichment_numeric((f->'value')->1)
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION boolean_filter_matches(data jsonb, f jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE f->>'operator'
    WHEN 'is_true' THEN
      CASE jsonb_typeof(data -> (f->>'key'))
        WHEN 'boolean' THEN ((data -> (f->>'key')) #>> '{}') = 'true'
        WHEN 'string' THEN lower((data -> (f->>'key')) #>> '{}') IN ('true', 'yes', '1')
        ELSE false
      END
    WHEN 'is_false' THEN
      CASE jsonb_typeof(data -> (f->>'key'))
        WHEN 'boolean' THEN ((data -> (f->>'key')) #>> '{}') = 'false'
        WHEN 'string' THEN lower((data -> (f->>'key')) #>> '{}') IN ('false', 'no', '0')
        ELSE false
      END
    ELSE false
  END
$$;

-- contains/not_contains use the `?` (jsonb "does this string exist as a
-- top-level array element") operator rather than `@> jsonb_build_array(...)`
-- (ticket #36 perf fix, confirmed against the live ~110k-row companies
-- table): `?` is a plain built-in binary operator with no per-row function
-- call, while `jsonb_build_array` is invoked fresh on every row to wrap the
-- target value before the containment check — measured to push the full
-- scan past statement_timeout where `?` completes in line with the other
-- per-type helpers (text/number/date/boolean). Semantics are identical for
-- this case since the filter value is always a scalar string (never a
-- multi-value array like Text's is/is_not, ticket #38) — `?` compares each
-- array member by exact string equality, so "a3" still never matches "a30".
--
-- contains/not_contains are wrapped in COALESCE (ticket #36 correctness fix,
-- found via integration test: a near-string that should never match came
-- back with ~98k false positives, exactly the count of rows where the key
-- is absent from custom_data entirely). `jsonb_typeof(NULL)` is SQL NULL,
-- not a string, so `jsonb_typeof(data -> key) = 'array'` is NULL — not
-- false — whenever the key is missing, and `NULL AND ...` is NULL too. That
-- NULL predicate breaks companies_matching_virtual_filters' `NOT EXISTS
-- (... WHERE NOT virtual_filter_predicate_matches(...))` AND-semantics:
-- `NOT NULL` is NULL, so a row with a NULL predicate is never excluded by
-- the EXISTS check, which means it's treated as matching every filter
-- regardless of value. text/number/date/boolean already avoid this (via
-- COALESCE, explicit IS NOT NULL guards, or an ELSE false terminating every
-- CASE) — list's contains/not_contains were the one branch that could still
-- evaluate to NULL instead of a definite boolean. COALESCE forces a missing
-- key to definite false for contains (no array, so it can't contain
-- anything) and definite true for not_contains (same reasoning Text's
-- not_contains already applies to a missing value via its own COALESCE).
-- Chip-input dispatch helper for List contains (ticket #116): true iff
-- `data_value` (the row's array) is a jsonb array containing the scalar
-- `value` as an exact member, or — when `value` is itself a jsonb array, the
-- chip input's stacked keywords — shares *any* member with it. The array
-- branch uses `?|` ("does any of these text[] elements exist as a top-level
-- array element"), the same operator ticket #36 chose over
-- `jsonb_build_array` for the scalar case: a plain built-in binary op, no
-- per-row function call, once `value` is materialized to a text[]. Kept as
-- its own function — called as a single flat FuncExpr from list_filter_matches'
-- 'contains'/'not_contains' arms, not a *nested* CASE inside its own body —
-- for the same reason as text_contains_matches above: a second CASE nested in
-- one arm was enough to knock the whole calling function off Postgres's
-- inliner in the Text case (confirmed via EXPLAIN ANALYZE against the live
-- table), and every arm here must stay flat to avoid the same regression.
-- `ARRAY(SELECT jsonb_array_elements_text(...))` is itself a SubLink, so it
-- has to live in a called function rather than list_filter_matches' own body
-- either way. Missing-key COALESCE reasoning matches ticket #36's original
-- single-value branches (false for contains, true for not_contains via the
-- NOT at the call site — see below).
CREATE OR REPLACE FUNCTION list_contains_matches(data_value jsonb, value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'array' THEN COALESCE(
      jsonb_typeof(data_value) = 'array' AND data_value ?| ARRAY(SELECT jsonb_array_elements_text(value)),
      false
    )
    ELSE COALESCE(jsonb_typeof(data_value) = 'array' AND data_value ? (value #>> '{}'), false)
  END
$$;

CREATE OR REPLACE FUNCTION list_filter_matches(data jsonb, f jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE f->>'operator'
    WHEN 'contains' THEN list_contains_matches(data -> (f->>'key'), f->'value')
    WHEN 'not_contains' THEN NOT list_contains_matches(data -> (f->>'key'), f->'value')
    WHEN 'is_empty' THEN is_empty_enrichment_value(data -> (f->>'key'))
    WHEN 'is_not_empty' THEN NOT is_empty_enrichment_value(data -> (f->>'key'))
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION date_filter_matches(data jsonb, f jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE f->>'operator'
    WHEN 'on' THEN enrichment_date_text(data -> (f->>'key')) IS NOT NULL AND enrichment_date_text(data -> (f->>'key')) = enrichment_date_text(f->'value')
    WHEN 'before' THEN enrichment_date_text(data -> (f->>'key')) IS NOT NULL AND enrichment_date_text(data -> (f->>'key')) < enrichment_date_text(f->'value')
    WHEN 'after' THEN enrichment_date_text(data -> (f->>'key')) IS NOT NULL AND enrichment_date_text(data -> (f->>'key')) > enrichment_date_text(f->'value')
    WHEN 'between' THEN
      enrichment_date_text(data -> (f->>'key')) IS NOT NULL
      AND enrichment_date_text(data -> (f->>'key')) BETWEEN enrichment_date_text((f->'value')->0) AND enrichment_date_text((f->'value')->1)
    ELSE false
  END
$$;

CREATE OR REPLACE FUNCTION virtual_filter_predicate_matches(data jsonb, f jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE f->>'type'
    WHEN 'text' THEN text_filter_matches(data, f)
    WHEN 'number' THEN number_filter_matches(data, f)
    WHEN 'boolean' THEN boolean_filter_matches(data, f)
    WHEN 'list' THEN list_filter_matches(data, f)
    WHEN 'date' THEN date_filter_matches(data, f)
    ELSE false
  END
$$;

-- Folds a grouped virtual-filter set `{combinator, groups:[{combinator,
-- conditions:[...]}]}` (ticket #117) into one boolean: conditions combine
-- inside a group with the group's combinator (AND/OR), and groups combine at
-- the top with the set's combinator. AND folds are `NOT EXISTS (... WHERE NOT
-- predicate)` (all must match); OR folds are `EXISTS (... WHERE predicate)`
-- (any matches). An empty/null set (`->'groups'` absent or []) matches every
-- row — the no-virtual-filters-active case that keeps native filtering
-- unchanged (top-level AND over zero groups is `NOT EXISTS over empty` = true;
-- callers additionally short-circuit on `jsonb_array_length(...->'groups') =
-- 0` so a top-level *OR* over zero groups can't collapse to "match nothing").
-- A single AND group of ANDed conditions reproduces the pre-#117 flat-AND
-- result exactly (backward compatible).
--
-- Kept as the single documented definition of "how a grouped virtual filter
-- set matches", but every caller below (list, facet, and discovery RPCs alike)
-- inlines this same nested-EXISTS shape directly into its own WHERE clause
-- instead of calling this function, because a `LANGUAGE sql` function whose
-- body contains an EXISTS (a SubLink) can never be inlined by the planner (PG's
-- inline_function() bails out whenever hasSubLinks is set) — calling it from
-- another query's per-row predicate means every row pays the overhead of a
-- full opaque SQL-function call that internally re-executes a subquery,
-- confirmed via EXPLAIN ANALYZE to cost ~100x a plain in-line predicate over
-- the same ~110k rows (69ms vs 8s+/timeout). The leaf
-- `virtual_filter_predicate_matches` has no SubLink in its body, so once it's
-- the only function call left in the inlined chain the planner folds its CASE
-- directly into each EXISTS' WHERE clause. First caught in the two
-- list-filtering RPCs (ticket #34 perf fix); the facet RPCs
-- (company_filter_options/person_filter_options) and the discovery RPCs
-- (company_enrichment_fields/person_enrichment_fields) had the same bug and
-- were fixed the same way later (ticket #37 perf fix) — no caller should
-- reference this function directly.
CREATE OR REPLACE FUNCTION virtual_filters_match(data jsonb, filters jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT
    COALESCE(jsonb_array_length(filters->'groups'), 0) = 0
    OR CASE WHEN COALESCE(filters->>'combinator', 'and') = 'or' THEN
      EXISTS (
        SELECT 1 FROM jsonb_array_elements(filters->'groups') AS grp
        WHERE CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
            EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                    WHERE virtual_filter_predicate_matches(data, cond))
          ELSE
            NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                        WHERE NOT virtual_filter_predicate_matches(data, cond))
          END
      )
    ELSE
      NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(filters->'groups') AS grp
        WHERE NOT (CASE WHEN COALESCE(grp->>'combinator', 'and') = 'or' THEN
            EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                    WHERE virtual_filter_predicate_matches(data, cond))
          ELSE
            NOT EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(grp->'conditions', '[]'::jsonb)) AS cond
                        WHERE NOT virtual_filter_predicate_matches(data, cond))
          END)
      )
    END
$$;

-- Resolves the id set a request's *entire* filter set (native + virtual)
-- narrows to, in one scan. Takes the same jsonb shape company_filter_options
-- does (lib/data/companies.ts toFilterOptionsRpcPayload) and applies the
-- identical native predicate (search / employee size / niche / source /
-- industry / country / email+phone presence / emailStatus / phoneType —
-- mirrors applyCompanyFilters and company_filter_options' `base` CTE)
-- ANDed with the virtual-filter predicate. Applying the native filters here
-- too (not just the virtual half) matters: without them this would scan the
-- *whole* companies table on every virtual-filtered request regardless of
-- how narrow the native filters already are, instead of the same bounded
-- working set the native filters produce — which is what "no path pays for
-- a second scan" (ticket #33) actually requires. The companies/people list,
-- export, and Clay/GHL push functions (lib/data/companies.ts,
-- lib/data/people.ts) call this only when `filters.virtualFilters` is
-- non-empty, then intersect via `.in("id", ids)`; when no virtual filter is
-- active they skip this entirely and existing native-filtering behavior is
-- unchanged.
--
-- ticket #34 perf fix: the virtual-filter AND-across-filters check is
-- inlined here as `NOT EXISTS (... WHERE NOT virtual_filter_predicate_matches
-- (...))` directly in this function's own WHERE clause, rather than calling
-- the shared `virtual_filters_match` helper. Calling `virtual_filters_match`
-- from here (as ticket #33 originally did) meant every one of the ~110k
-- company rows paid the cost of an opaque, non-inlinable SQL-function call:
-- Postgres's planner will never inline a `LANGUAGE sql` function whose body
-- contains a SubLink (an `EXISTS (...)`  qualifies), so each row's check ran
-- as a full nested query execution rather than a plain filter expression —
-- confirmed via EXPLAIN ANALYZE (an equivalent raw predicate with no
-- function layer at all scanned all ~110k rows in ~69ms; the
-- virtual_filters_match-wrapped version timed out past Postgres's
-- statement_timeout on the same table for the 'is'/'contains' operators).
-- `virtual_filter_predicate_matches` itself has no CTE/SubLink/aggregate in
-- its body, so once it's the *only* function call in the chain (not nested
-- inside another opaque function), the planner inlines its CASE expression
-- directly into this EXISTS subquery's WHERE clause, and the whole thing
-- runs as ordinary per-row filter evaluation — no per-row function-call
-- overhead left. `virtual_filters_match` itself is kept only as the
-- documented reference definition — the facet RPCs
-- (company_filter_options/person_filter_options in canonical-columns.sql)
-- and the discovery RPCs (company_enrichment_fields/person_enrichment_fields
-- in enrichment-fields.sql) had the same non-inlinable-call bug and were
-- fixed the same way later (ticket #37 perf fix); no caller should reference
-- `virtual_filters_match` directly.
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
    -- Grouped virtual-filter fold (ticket #117), inlined per the perf note on
    -- virtual_filters_match — must stay in lockstep with the identical fold in
    -- people_matching_virtual_filters, company_filter_options /
    -- person_filter_options, and company_enrichment_fields /
    -- person_enrichment_fields (grep virtual_filter_predicate_matches).
    AND (
      COALESCE(jsonb_array_length(p.virtual_filters->'groups'), 0) = 0
      OR CASE WHEN COALESCE(p.virtual_filters->>'combinator', 'and') = 'or' THEN
        EXISTS (
          SELECT 1 FROM jsonb_array_elements(p.virtual_filters->'groups') AS grp
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
          SELECT 1 FROM jsonb_array_elements(p.virtual_filters->'groups') AS grp
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
  ORDER BY c.id
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
    -- Grouped virtual-filter fold (ticket #117) — identical to the companies
    -- copy above; keep in lockstep with all six inlined copies.
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
  ORDER BY p.id
$$;
