-- T39 / #149 fix round 1: run once in the Supabase SQL editor.
-- Adds inclusive-bound operators (Number's "at least"/"at most", Date's
-- "on or after"/"on or before") and makes enrichment_numeric tolerant of
-- common formatted numbers ("$12,000", " 5000 ", "12,000.50"). These are the
-- same three functions defined in the canonical lib/data/virtual-columns.sql
-- (already updated there) — this file exists only to be applied standalone
-- without re-running virtual-columns.sql's DROP FUNCTION IF EXISTS cleanup
-- and every other function it defines, matching the repo's small-migration
-- pattern (e.g. ticket-awaiting-reply-status.sql). CREATE OR REPLACE is
-- idempotent, so re-running this file is always safe.

-- Cast-safe numeric read of an enrichment value: NULL (never an exception)
-- for anything that isn't a clean number, so a Number filter drops
-- non-numeric junk ("$10", "-", "{{ 0 }}", stray strings) instead of 500ing
-- the request (ADR-0002). Regex-guards before casting because Postgres has
-- no try_cast. Handles both a real JSON number and a numeric-looking string,
-- since the same custom_data key holds either shape across rows.
--
-- A string is stripped of whitespace, currency symbols ($/€/£) and
-- thousands-separator commas before the regex check (ticket #39), so common
-- enrichment formatting parses instead of falling through to junk: "$12,000",
-- " 5000 ", "12,000.50" all read as their plain numeric value. Stripped once
-- into the WHEN's own condition and again in its THEN (rather than hoisted
-- into a nested CASE) to keep this a single flat CASE — see virtual-columns.sql's
-- file header on why a nested CASE inside a per-row-called function is
-- avoided here. A range like "$500K-$1M" still comes out NULL: stripping
-- only removes currency symbols/commas/whitespace, so the letters and the
-- middle "-" survive and fail the digits-only regex, same as before.
CREATE OR REPLACE FUNCTION enrichment_numeric(v jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN v IS NULL THEN NULL
    WHEN jsonb_typeof(v) = 'number' THEN (v #>> '{}')::numeric
    WHEN jsonb_typeof(v) = 'string' AND regexp_replace(v #>> '{}', '[\s$€£,]', '', 'g') ~ '^-?[0-9]+(\.[0-9]+)?$'
      THEN regexp_replace(v #>> '{}', '[\s$€£,]', '', 'g')::numeric
    ELSE NULL
  END
$$;

-- `gte`/`lte` (at least / at most) round out `gt`/`lt` with inclusive bounds
-- (ticket #39) — same IS NOT NULL guard as every other branch, just >= / <=.
CREATE OR REPLACE FUNCTION number_filter_matches(data jsonb, f jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE f->>'operator'
    WHEN 'is' THEN enrichment_numeric(data -> (f->>'key')) IS NOT NULL AND enrichment_numeric(data -> (f->>'key')) = enrichment_numeric(f->'value')
    WHEN 'is_not' THEN enrichment_numeric(data -> (f->>'key')) IS NOT NULL AND enrichment_numeric(data -> (f->>'key')) <> enrichment_numeric(f->'value')
    WHEN 'gt' THEN enrichment_numeric(data -> (f->>'key')) IS NOT NULL AND enrichment_numeric(data -> (f->>'key')) > enrichment_numeric(f->'value')
    WHEN 'lt' THEN enrichment_numeric(data -> (f->>'key')) IS NOT NULL AND enrichment_numeric(data -> (f->>'key')) < enrichment_numeric(f->'value')
    WHEN 'gte' THEN enrichment_numeric(data -> (f->>'key')) IS NOT NULL AND enrichment_numeric(data -> (f->>'key')) >= enrichment_numeric(f->'value')
    WHEN 'lte' THEN enrichment_numeric(data -> (f->>'key')) IS NOT NULL AND enrichment_numeric(data -> (f->>'key')) <= enrichment_numeric(f->'value')
    WHEN 'between' THEN
      enrichment_numeric(data -> (f->>'key')) IS NOT NULL
      AND enrichment_numeric(data -> (f->>'key')) BETWEEN enrichment_numeric((f->'value')->0) AND enrichment_numeric((f->'value')->1)
    ELSE false
  END
$$;

-- `on_or_after`/`on_or_before` round out `after`/`before` with inclusive
-- bounds (ticket #39) — same IS NOT NULL guard as every other branch, just
-- >= / <=.
CREATE OR REPLACE FUNCTION date_filter_matches(data jsonb, f jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE f->>'operator'
    WHEN 'on' THEN enrichment_date_text(data -> (f->>'key')) IS NOT NULL AND enrichment_date_text(data -> (f->>'key')) = enrichment_date_text(f->'value')
    WHEN 'before' THEN enrichment_date_text(data -> (f->>'key')) IS NOT NULL AND enrichment_date_text(data -> (f->>'key')) < enrichment_date_text(f->'value')
    WHEN 'after' THEN enrichment_date_text(data -> (f->>'key')) IS NOT NULL AND enrichment_date_text(data -> (f->>'key')) > enrichment_date_text(f->'value')
    WHEN 'on_or_before' THEN enrichment_date_text(data -> (f->>'key')) IS NOT NULL AND enrichment_date_text(data -> (f->>'key')) <= enrichment_date_text(f->'value')
    WHEN 'on_or_after' THEN enrichment_date_text(data -> (f->>'key')) IS NOT NULL AND enrichment_date_text(data -> (f->>'key')) >= enrichment_date_text(f->'value')
    WHEN 'between' THEN
      enrichment_date_text(data -> (f->>'key')) IS NOT NULL
      AND enrichment_date_text(data -> (f->>'key')) BETWEEN enrichment_date_text((f->'value')->0) AND enrichment_date_text((f->'value')->1)
    ELSE false
  END
$$;
