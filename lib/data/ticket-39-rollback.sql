-- ROLLBACK for lib/data/ticket-39-number-date-inclusive-operators.sql (T39, #149).
--
-- Snapshot of the live definitions taken from project swfykpknnfunpapzoudn
-- (pg_get_functiondef) on 2026-09-28, immediately before the T39 migration
-- was applied. Running this file restores the pre-T39 behaviour exactly:
-- the three original functions come back, then the two helpers T39 added
-- are dropped (nothing else calls them).

CREATE OR REPLACE FUNCTION public.enrichment_numeric(v jsonb)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN v IS NULL THEN NULL
    WHEN jsonb_typeof(v) = 'number' THEN (v #>> '{}')::numeric
    WHEN jsonb_typeof(v) = 'string' AND (v #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?$' THEN (v #>> '{}')::numeric
    ELSE NULL
  END
$function$;

CREATE OR REPLACE FUNCTION public.number_filter_matches(data jsonb, f jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
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
$function$;

CREATE OR REPLACE FUNCTION public.date_filter_matches(data jsonb, f jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE f->>'operator'
    WHEN 'on' THEN enrichment_date_text(data -> (f->>'key')) IS NOT NULL AND enrichment_date_text(data -> (f->>'key')) = enrichment_date_text(f->'value')
    WHEN 'before' THEN enrichment_date_text(data -> (f->>'key')) IS NOT NULL AND enrichment_date_text(data -> (f->>'key')) < enrichment_date_text(f->'value')
    WHEN 'after' THEN enrichment_date_text(data -> (f->>'key')) IS NOT NULL AND enrichment_date_text(data -> (f->>'key')) > enrichment_date_text(f->'value')
    WHEN 'between' THEN
      enrichment_date_text(data -> (f->>'key')) IS NOT NULL
      AND enrichment_date_text(data -> (f->>'key')) BETWEEN enrichment_date_text((f->'value')->0) AND enrichment_date_text((f->'value')->1)
    ELSE false
  END
$function$;

DROP FUNCTION IF EXISTS public.number_compare_matches(jsonb, text, jsonb);
DROP FUNCTION IF EXISTS public.date_compare_matches(jsonb, text, jsonb);
