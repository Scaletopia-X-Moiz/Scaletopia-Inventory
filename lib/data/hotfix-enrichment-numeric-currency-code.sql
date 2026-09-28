-- Hotfix: enrichment_numeric also strips a three-letter currency code.
--
-- Cause: every estimated_monthly_sales value is stored as text like
-- "USD $92,736.76". enrichment_numeric stripped "$" but not the "USD "
-- prefix, so every value came out NULL and any Number filter on that key
-- (even "is not 100") matched 0 companies.
--
-- Fix: the cleanup regex now also removes a leading or trailing three-letter
-- uppercase currency code, and whitespace after a currency symbol. Checked
-- against live data: 96,205 of 96,473 estimated_monthly_sales values now
-- parse; plain text like "Shopify" still comes out NULL.
--
-- Run this in the Supabase SQL editor. To revert, re-run the
-- enrichment_numeric definition from ticket-39-rollback.sql's T39 version
-- (i.e. this same function with '[$€£]' as the cleanup pattern).

CREATE OR REPLACE FUNCTION public.enrichment_numeric(v jsonb)
 RETURNS numeric
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT CASE
    WHEN v IS NULL THEN NULL
    WHEN jsonb_typeof(v) = 'number' THEN (v #>> '{}')::numeric
    WHEN jsonb_typeof(v) = 'string'
      AND regexp_replace(trim(both from (v #>> '{}')), '^[A-Z]{3}\s*|\s*[A-Z]{3}$|[$€£]\s*', '', 'g') ~ '^-?\d{1,3}(,\d{3})+(\.\d+)?$'
      THEN regexp_replace(regexp_replace(trim(both from (v #>> '{}')), '^[A-Z]{3}\s*|\s*[A-Z]{3}$|[$€£]\s*', '', 'g'), ',', '', 'g')::numeric
    WHEN jsonb_typeof(v) = 'string'
      AND regexp_replace(trim(both from (v #>> '{}')), '^[A-Z]{3}\s*|\s*[A-Z]{3}$|[$€£]\s*', '', 'g') ~ '^-?\d+(\.\d+)?$'
      THEN regexp_replace(trim(both from (v #>> '{}')), '^[A-Z]{3}\s*|\s*[A-Z]{3}$|[$€£]\s*', '', 'g')::numeric
    ELSE NULL
  END
$function$;
