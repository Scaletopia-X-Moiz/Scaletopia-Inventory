-- Import key lookup: preflight / push look up ONLY the keys in the import,
-- server-side, via indexes — instead of downloading every companies/people row
-- (lib/import/push.ts used to page the whole table with deep OFFSETs, which hit
-- the 30s service_role statement_timeout at ~390k companies: "57014").
--
-- Applied to production (swfykpknnfunpapzoudn) 2026-09-30. Rollback:
-- lib/data/import-key-lookup-rollback.sql.
--
-- CANONICAL LINKEDIN KEY — must stay identical in three places:
--   1. the expression indexes below,
--   2. the WHERE clauses of the RPCs below and of import_bulk_update_* in
--      lib/import/migrations.sql,
--   3. canonicalLinkedIn() in lib/import/push.ts.
-- Form: regexp_replace(lower(rtrim(linkedin_url, '/')), '^https?://(www\.)?', '')
-- Stored URLs are mostly WITHOUT the trailing slash that normalizeLinkedInUrl
-- adds, ~45k companies are stored as http://, and a few are mixed case — this
-- form matches all of those. Stored data is NOT rewritten.

-- ---------------------------------------------------------------------------
-- Indexes. CONCURRENTLY cannot run inside a transaction: run one at a time.
-- Partial (WHERE ... IS NOT NULL): queries must repeat that predicate.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_companies_linkedin_canon
  ON public.companies ((regexp_replace(lower(rtrim(linkedin_url, '/')), '^https?://(www\.)?', '')))
  WHERE linkedin_url IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_people_linkedin_canon
  ON public.people ((regexp_replace(lower(rtrim(linkedin_url, '/')), '^https?://(www\.)?', '')))
  WHERE linkedin_url IS NOT NULL;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_people_email_lower
  ON public.people ((lower(email)))
  WHERE email IS NOT NULL;

-- Duplicate of idx_companies_domain_unique (same column; the unique one is
-- partial WHERE domain IS NOT NULL and serves every `domain = x` lookup).
DROP INDEX CONCURRENTLY IF EXISTS public.idx_companies_domain;

-- ---------------------------------------------------------------------------
-- Read-only lookup RPCs. service_role only.

-- Which of the given keys already exist in companies. Returns at most two
-- rows (kind = 'domain' | 'linkedin'), each with the matching INPUT keys
-- exactly as passed, so the caller looks its own keys up without re-deriving
-- anything. Results are aggregated (not one row per key) because PostgREST
-- caps set-returning RPC results at db-max-rows (1000), which would silently
-- truncate a 5000-key chunk. p_domains are compared exactly (import domains
-- are normalized lowercase; stored ones are all lowercase). p_linkedins are
-- compared in canonical form (idx_companies_linkedin_canon).
DROP FUNCTION IF EXISTS public.import_match_companies(text[], text[]);
CREATE FUNCTION public.import_match_companies(p_domains text[], p_linkedins text[])
RETURNS TABLE(kind text, keys text[])
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT 'domain'::text, COALESCE(array_agg(d), '{}'::text[])
  FROM unnest(COALESCE(p_domains, '{}'::text[])) AS d
  WHERE EXISTS (SELECT 1 FROM companies c WHERE c.domain = d)
  UNION ALL
  SELECT 'linkedin'::text, COALESCE(array_agg(l), '{}'::text[])
  FROM unnest(COALESCE(p_linkedins, '{}'::text[])) AS l
  WHERE EXISTS (
    SELECT 1 FROM companies c
    WHERE c.linkedin_url IS NOT NULL
      AND regexp_replace(lower(rtrim(c.linkedin_url, '/')), '^https?://(www\.)?', '')
        = regexp_replace(lower(rtrim(l, '/')), '^https?://(www\.)?', '')
  );
$$;

-- Same for people: LinkedIn (canonical, idx_people_linkedin_canon) and email
-- (case-insensitive, idx_people_email_lower).
DROP FUNCTION IF EXISTS public.import_match_people(text[], text[]);
CREATE FUNCTION public.import_match_people(p_linkedins text[], p_emails text[])
RETURNS TABLE(kind text, keys text[])
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT 'linkedin'::text, COALESCE(array_agg(l), '{}'::text[])
  FROM unnest(COALESCE(p_linkedins, '{}'::text[])) AS l
  WHERE EXISTS (
    SELECT 1 FROM people p
    WHERE p.linkedin_url IS NOT NULL
      AND regexp_replace(lower(rtrim(p.linkedin_url, '/')), '^https?://(www\.)?', '')
        = regexp_replace(lower(rtrim(l, '/')), '^https?://(www\.)?', '')
  )
  UNION ALL
  SELECT 'email'::text, COALESCE(array_agg(e), '{}'::text[])
  FROM unnest(COALESCE(p_emails, '{}'::text[])) AS e
  WHERE EXISTS (
    SELECT 1 FROM people p
    WHERE p.email IS NOT NULL AND lower(p.email) = lower(e)
  );
$$;

-- Company rows for the given domains, as one jsonb array (same db-max-rows
-- reason): links imported people to their employer (people.company_id) and
-- carries the company's canonical fields onto them.
DROP FUNCTION IF EXISTS public.import_companies_by_domain(text[]);
CREATE FUNCTION public.import_companies_by_domain(p_domains text[])
RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id', c.id, 'domain', c.domain, 'client', c.client, 'niche', c.niche,
    'industry_id', c.industry_id, 'employee_count', c.employee_count,
    'linkedin_url', c.linkedin_url)), '[]'::jsonb)
  FROM companies c
  WHERE c.domain = ANY(COALESCE(p_domains, '{}'::text[]));
$$;

-- Distinct non-null companies.client values via a recursive skip-scan over
-- idx_companies_client (one index probe per distinct client — ~ms, vs seconds
-- for SELECT DISTINCT over the whole table). Raw values; callers trim/lower.
CREATE OR REPLACE FUNCTION public.import_known_clients()
RETURNS SETOF text
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH RECURSIVE t(c) AS (
    SELECT min(client) FROM companies WHERE client IS NOT NULL
    UNION ALL
    SELECT (SELECT min(client) FROM companies WHERE client > t.c)
    FROM t WHERE t.c IS NOT NULL
  )
  SELECT c FROM t WHERE c IS NOT NULL;
$$;

REVOKE ALL ON FUNCTION public.import_match_companies(text[], text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.import_match_people(text[], text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.import_companies_by_domain(text[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.import_known_clients() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.import_match_companies(text[], text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.import_match_people(text[], text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.import_companies_by_domain(text[]) TO service_role;
GRANT EXECUTE ON FUNCTION public.import_known_clients() TO service_role;

-- The updated import_bulk_update_companies / import_bulk_update_people (which
-- match on the same canonical keys) live in lib/import/migrations.sql.
