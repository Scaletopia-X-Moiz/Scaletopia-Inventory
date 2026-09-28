-- T39 / #149 fix round 2: run once in the Supabase SQL editor.
-- Supersedes the fix round 1 version of this file (same name, same path).
-- Adds inclusive-bound operators (Number's "at least"/"at most", Date's
-- "on or after"/"on or before"), makes enrichment_numeric tolerant of
-- common formatted numbers ("$12,000", " 5000 ", "12,000.50", "-$5", "$-5")
-- while staying strict about comma placement, and splits number_filter_matches
-- / date_filter_matches into a thin dispatcher plus a small compare helper
-- (number_compare_matches / date_compare_matches) to pre-empt the same
-- planner-inlining regression that hit text_filter_matches in production
-- (see the LIVE PRODUCTION FINDING note in lib/data/virtual-columns.sql).
--
-- These five functions are defined identically in the canonical
-- lib/data/virtual-columns.sql (already updated there); this file exists
-- only to be applied standalone without re-running virtual-columns.sql's
-- DROP FUNCTION IF EXISTS cleanup and every other function it defines,
-- matching the repo's small-migration pattern (e.g.
-- ticket-awaiting-reply-status.sql). CREATE OR REPLACE is idempotent, so
-- re-running this file is always safe. Helpers are defined before the
-- functions that call them, same order as the canonical file.

-- Cast-safe numeric read of an enrichment value: NULL (never an exception)
-- for anything that isn't a clean number, so a Number filter drops
-- non-numeric junk ("$10", "-", "{{ 0 }}", stray strings) instead of 500ing
-- the request (ADR-0002). Regex-guards before casting because Postgres has
-- no try_cast. Handles both a real JSON number and a numeric-looking string,
-- since the same custom_data key holds either shape across rows.
--
-- A string is trimmed of leading/trailing whitespace and has its currency
-- symbols ($, euro, pound) removed before either regex check (ticket #39
-- fix round 2). Only two shapes are then accepted: a plain number
-- (^-?\d+(\.\d+)?$, e.g. "5000" or "-5" from either "-$5" or "$-5", the
-- currency-symbol removal leaves the minus adjacent to the digits either
-- way), or a comma-grouped thousands number (^-?\d{1,3}(,\d{3})+(\.\d+)?$,
-- e.g. "12,000" or "1,234,567.50", commas stripped only after the shape is
-- confirmed correct). This is deliberately narrower than "strip every
-- comma": "1,5" and "1,2,3" have commas in the wrong place and stay NULL,
-- and "12.000,50" (comma-as-decimal formatting) matches neither shape and
-- stays NULL too. A range like "$500K-$1M" still comes out NULL, the
-- letters and the middle "-" fail both regexes regardless of the comma
-- handling. Each condition and its THEN repeat the same cleanup call
-- (trim plus currency-symbol removal, and the comma strip in the grouped
-- branch) rather than sharing it through a nested CASE or a FROM subquery,
-- to keep this one flat CASE with no FROM clause. See the file header on
-- why a nested CASE (or a FROM clause, which blocks Postgres's function
-- inliner outright) is avoided in a per-row-called function like this one.
CREATE OR REPLACE FUNCTION enrichment_numeric(v jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN v IS NULL THEN NULL
    WHEN jsonb_typeof(v) = 'number' THEN (v #>> '{}')::numeric
    WHEN jsonb_typeof(v) = 'string'
      AND regexp_replace(trim(both from (v #>> '{}')), '[$€£]', '', 'g') ~ '^-?\d{1,3}(,\d{3})+(\.\d+)?$'
      THEN regexp_replace(regexp_replace(trim(both from (v #>> '{}')), '[$€£]', '', 'g'), ',', '', 'g')::numeric
    WHEN jsonb_typeof(v) = 'string'
      AND regexp_replace(trim(both from (v #>> '{}')), '[$€£]', '', 'g') ~ '^-?\d+(\.\d+)?$'
      THEN regexp_replace(trim(both from (v #>> '{}')), '[$€£]', '', 'g')::numeric
    ELSE NULL
  END
$$;

-- PERF SPLIT (ticket #39 fix round 2, pre-empting the LIVE PRODUCTION FINDING
-- above): adding gte/lte took number_filter_matches to 7 operator arms
-- (was 5), the same growth-past-the-inlining-threshold risk that broke
-- text_filter_matches at 6 arms. Applying the same fix here before it ships:
-- pull the whole operator dispatch out into this small, flat, IMMUTABLE
-- helper, so number_filter_matches itself (below) goes back to being a
-- two-call, zero-branch body, well under whatever threshold the planner
-- uses. `row_value` is the row's raw jsonb value. It is cast inside each
-- arm so the argument the caller passes stays a cheap `data -> key`
-- expression, which keeps this helper inlinable (Postgres will not inline a
-- function whose multiply-referenced parameter receives an expensive
-- argument, and an enrichment_numeric(...) call is expensive). Every arm stays a single
-- flat comparison, no CASE-inside-CASE, no SubLink, matching the file's
-- inlining rules even though (like list_contains_matches) this particular
-- helper may itself stay opaque, an opaque call from an already-inlined,
-- near-trivial caller is the same cheap shape list_filter_matches already
-- proved out.
CREATE OR REPLACE FUNCTION number_compare_matches(row_value jsonb, op text, val jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE op
    WHEN 'is' THEN enrichment_numeric(row_value) = enrichment_numeric(val)
    WHEN 'is_not' THEN enrichment_numeric(row_value) <> enrichment_numeric(val)
    WHEN 'gt' THEN enrichment_numeric(row_value) > enrichment_numeric(val)
    WHEN 'lt' THEN enrichment_numeric(row_value) < enrichment_numeric(val)
    WHEN 'gte' THEN enrichment_numeric(row_value) >= enrichment_numeric(val)
    WHEN 'lte' THEN enrichment_numeric(row_value) <= enrichment_numeric(val)
    WHEN 'between' THEN enrichment_numeric(row_value) BETWEEN enrichment_numeric(val->0) AND enrichment_numeric(val->1)
    ELSE false
  END
$$;

-- Thin dispatcher (ticket #39 fix round 2): casts the row value via
-- enrichment_numeric for the NULL guard, then hands the raw jsonb to
-- number_compare_matches (no FROM subquery, since a FROM clause blocks
-- Postgres's function inliner, see enrichment_numeric's comment above). The NULL guard on the left of the AND makes
-- the whole expression false whenever the row value doesn't cast, no
-- matter what number_compare_matches itself returns.
CREATE OR REPLACE FUNCTION number_filter_matches(data jsonb, f jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT enrichment_numeric(data -> (f->>'key')) IS NOT NULL
    AND number_compare_matches(data -> (f->>'key'), f->>'operator', f->'value')
$$;

-- PERF SPLIT (ticket #39 fix round 2): same reasoning as number_compare_matches
-- above, adding on_or_after/on_or_before took date_filter_matches to 6
-- operator arms (was 4), the exact arm count that broke text_filter_matches's
-- inlining on production. `row_value` is the row's raw jsonb value, cast
-- inside each arm for the same inlining reason as number_compare_matches
-- (the caller passes only a cheap `data -> key` expression).
CREATE OR REPLACE FUNCTION date_compare_matches(row_value jsonb, op text, val jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE op
    WHEN 'on' THEN enrichment_date_text(row_value) = enrichment_date_text(val)
    WHEN 'before' THEN enrichment_date_text(row_value) < enrichment_date_text(val)
    WHEN 'after' THEN enrichment_date_text(row_value) > enrichment_date_text(val)
    WHEN 'on_or_before' THEN enrichment_date_text(row_value) <= enrichment_date_text(val)
    WHEN 'on_or_after' THEN enrichment_date_text(row_value) >= enrichment_date_text(val)
    WHEN 'between' THEN enrichment_date_text(row_value) BETWEEN enrichment_date_text(val->0) AND enrichment_date_text(val->1)
    ELSE false
  END
$$;

-- Thin dispatcher (ticket #39 fix round 2), mirrors number_filter_matches
-- above: enrichment_date_text runs for the NULL guard, then the raw jsonb
-- goes to date_compare_matches (no FROM subquery, since a FROM clause would
-- block Postgres's function inliner, see enrichment_numeric's comment). The NULL guard makes the
-- whole expression false whenever the row value doesn't parse as an ISO date.
CREATE OR REPLACE FUNCTION date_filter_matches(data jsonb, f jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT enrichment_date_text(data -> (f->>'key')) IS NOT NULL
    AND date_compare_matches(data -> (f->>'key'), f->>'operator', f->'value')
$$;
