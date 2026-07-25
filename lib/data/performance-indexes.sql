-- Performance indexes for the Companies / People dashboards.
-- Run once in the Supabase SQL editor. Safe to re-run (all IF NOT EXISTS).
--
-- Context: the list pages pull filtered slices of `companies` (~87k rows) and
-- `people` (~6.5k rows). The filters that reach Postgres are search (ILIKE),
-- employee_count range, and the people->company_id lookups used for per-row
-- people counts and the company drawer. These indexes target exactly those.
--
-- NOTE: CREATE INDEX CONCURRENTLY cannot run inside a transaction block. The
-- Supabase SQL editor wraps statements in a transaction, so run the CONCURRENTLY
-- variants one at a time (or drop CONCURRENTLY to build with a brief write lock;
-- on tables this size the lock is short). CONCURRENTLY is kept here so a
-- production run doesn't block writes.

-- Trigram matching for the search box (company_name/domain, full_name/email).
-- A leading-wildcard ILIKE ('%term%') cannot use a btree index; pg_trgm GIN can.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX CONCURRENTLY IF NOT EXISTS companies_company_name_trgm
  ON companies USING gin (company_name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS companies_domain_trgm
  ON companies USING gin (domain gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS people_full_name_trgm
  ON people USING gin (full_name gin_trgm_ops);

CREATE INDEX CONCURRENTLY IF NOT EXISTS people_email_trgm
  ON people USING gin (email gin_trgm_ops);

-- Employee-size range filter on the Companies page.
CREATE INDEX CONCURRENTLY IF NOT EXISTS companies_employee_count
  ON companies (employee_count);

-- people -> company lookups: getPeopleByCompanyId (drawer) and the per-page
-- people-count tally (getPeopleCountsForCompanies, `company_id IN (...)`).
CREATE INDEX CONCURRENTLY IF NOT EXISTS people_company_id
  ON people (company_id);

-- Rows are sorted by last_updated DESC for display; helps any future
-- DB-side ordering/pagination of the list queries.
CREATE INDEX CONCURRENTLY IF NOT EXISTS companies_last_updated
  ON companies (last_updated DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS people_last_updated
  ON people (last_updated DESC);

-- ---------------------------------------------------------------------------
-- Index audit (Speed Optimization ticket)
--
-- The companies list now runs in two phases (see lib/data/companies.ts):
--   1. A full-table scan of the *narrow* FILTER_COLUMNS set to filter/facet/sort
--      in app code. With no search/employee filter this is a deliberate
--      sequential scan of every row — there is no WHERE clause to index, and a
--      covering index over the 11 filter columns is not worth the write
--      amplification on this churny, frequently-reimported table (and Postgres
--      won't reliably index-only-scan it anyway). The win there is payload size,
--      handled by dropping the wide display columns from the projection, not an
--      index. So: no new index is warranted for phase 1.
--   2. A by-id refetch of the display columns for just the visible page
--      (`... WHERE id IN (...)`), served by the companies primary key. Already
--      covered — no new index needed.
--
-- Every other filter that reaches Postgres is already covered above:
--   search (ILIKE)            -> *_trgm GIN indexes
--   employee_count range      -> companies_employee_count
--   people-by-company lookups -> people_company_id
-- Conclusion: the indexes above remain the complete, correct set; the speed win
-- for the list scan comes from the narrower projection, not from indexing.
