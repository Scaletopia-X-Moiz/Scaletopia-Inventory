-- ============================================================================
-- Manual deploy — run once in the Supabase SQL editor.
-- Batched fixes for the 4-Aug feedback retest. Direct DB DDL password is stale,
-- so these must be applied by hand (idempotent: all CREATE OR REPLACE / ALTER
-- IF NOT EXISTS).
-- ============================================================================

-- (1) Companies "categories" contains 503 fix — statement timeout (57014).
--     text_contains_matches had an EXISTS subquery that disqualified it from
--     Postgres's function inliner, so every text contains/not_contains ran as an
--     opaque per-row call over the full companies scan and timed out. Keep it
--     SubLink-free (inlinable) and push the one SubLink into a helper.
--     Semantics byte-identical. See lib/data/virtual-columns.sql.

CREATE OR REPLACE FUNCTION jsonb_ilike_patterns(value jsonb) RETURNS text[]
LANGUAGE sql IMMUTABLE AS $$
  SELECT ARRAY(SELECT '%' || kw || '%' FROM jsonb_array_elements_text(value) AS kw)
$$;

CREATE OR REPLACE FUNCTION text_contains_matches(text_value text, value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'array' THEN text_value ILIKE ANY (jsonb_ilike_patterns(value))
    ELSE text_value ILIKE ('%' || (value #>> '{}') || '%')
  END
$$;

-- (2) Push Activity created/updated split (feedback item 2b). Splits the single
--     `succeeded` counter into created (first-time push) vs updated (a
--     platform_pushes row already existed). Idempotent. App code degrades to 0
--     until this is applied, so the worker/panel won't crash beforehand.

ALTER TABLE push_jobs ADD COLUMN IF NOT EXISTS created integer NOT NULL DEFAULT 0;
ALTER TABLE push_jobs ADD COLUMN IF NOT EXISTS updated integer NOT NULL DEFAULT 0;
