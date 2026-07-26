-- Run once in the Supabase SQL editor (see docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md,
-- docs/prds/app-wide-navigation-and-dashboard-latency.md, issue #27).
--
-- RPC: the Overview dashboard's totals + niche/source/industry/country
-- breakdowns + 5 most-recent companies, in one query. Replaces getDashboard's
-- old approach of paging the entire companies table into the app
-- (lib/data/fetch-all-rows.ts) and counting in JavaScript. Groups on the
-- canonical columns from lib/data/canonical-columns.sql (country_id,
-- industry_id, source_tokens) plus the plain `niche` column, mirroring
-- company_filter_options' pattern exactly. Only ids/counts are returned;
-- labels are attached back in TS (sourceLabel/industryLabel/countryLabel) so
-- the alias/label tables stay single-edit-point in TypeScript, not
-- duplicated in SQL. `recentCompanies` returns the raw `country` text (not
-- country_id) so getDashboard can keep applying normalizeCountry() to it
-- exactly as before, preserving the existing recent-companies label
-- behavior bit-for-bit.
CREATE OR REPLACE FUNCTION dashboard_stats(range_from timestamptz DEFAULT NULL, range_to timestamptz DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE AS $$
WITH company_base AS MATERIALIZED (
  SELECT id, company_name, niche, industry_id, country_id, source_tokens, country, created_at
  FROM companies
  WHERE (range_from IS NULL OR created_at >= range_from)
    AND (range_to IS NULL OR created_at < range_to)
),
niches AS (
  SELECT niche AS id, count(*) AS count
  FROM company_base
  WHERE niche IS NOT NULL AND niche <> ''
  GROUP BY niche
),
sources AS (
  SELECT token AS id, count(*) AS count
  FROM (SELECT unnest(source_tokens) AS token FROM company_base) t
  GROUP BY token
),
industries AS (
  SELECT industry_id AS id, count(*) AS count
  FROM company_base
  WHERE industry_id IS NOT NULL
  GROUP BY industry_id
),
countries AS (
  SELECT country_id AS id, count(*) AS count
  FROM company_base
  WHERE country_id IS NOT NULL
  GROUP BY country_id
),
recent AS (
  SELECT id, company_name, niche, country, created_at
  FROM company_base
  ORDER BY created_at DESC
  LIMIT 5
),
people_total AS (
  SELECT count(*) AS count
  FROM people
  WHERE (range_from IS NULL OR created_at >= range_from)
    AND (range_to IS NULL OR created_at < range_to)
)
SELECT jsonb_build_object(
  'totalCompanies', (SELECT count(*) FROM company_base),
  'totalPeople', (SELECT count FROM people_total),
  'niches', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM niches), '[]'::jsonb),
  'sources', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM sources), '[]'::jsonb),
  'industries', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM industries), '[]'::jsonb),
  'countries', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', id, 'count', count)) FROM countries), '[]'::jsonb),
  'recentCompanies', COALESCE((SELECT jsonb_agg(jsonb_build_object(
    'id', id, 'name', company_name, 'niche', niche, 'country', country, 'createdAt', created_at
  )) FROM recent), '[]'::jsonb)
);
$$;
