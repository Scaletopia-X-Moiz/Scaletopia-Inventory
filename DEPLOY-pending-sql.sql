-- ============================================================================
-- DEPLOY-pending-sql.sql
-- SQL that must be run BY HAND in the Supabase SQL editor (prod DB).
-- This repo has no automated DDL path — merging .sql files does NOT deploy them.
--
-- Run the blocks below IN ORDER. Each has a verification probe.
-- Source of truth: lib/data/push-jobs.sql
-- ============================================================================


-- ----------------------------------------------------------------------------
-- [1] GitHub issue #135  —  claim_next_runnable_job  (BLOCKING: unsticks the
--     Push Activity queue). The push_jobs table is already live; this function
--     was added in a later commit and was likely never applied.
--
-- STEP 1a — Probe FIRST (optional). If this errors "function does not exist",
--           the missing function is confirmed as the root cause:
--     SELECT * FROM claim_next_runnable_job(3);
--
-- STEP 1b — Run this to create it:
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION claim_next_runnable_job(max_concurrent integer DEFAULT NULL)
RETURNS SETOF push_jobs
LANGUAGE sql
AS $$
  UPDATE push_jobs
  SET status = 'running', started_at = now()
  WHERE id = (
    SELECT j.id
    FROM push_jobs j
    WHERE j.status = 'queued'
      AND NOT EXISTS (
        SELECT 1 FROM push_jobs r
        WHERE r.status = 'running' AND r.client_id = j.client_id
      )
      AND (
        max_concurrent IS NULL
        OR (SELECT count(*) FROM push_jobs c WHERE c.status = 'running') < max_concurrent
      )
    ORDER BY j.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
$$;

-- STEP 1c — Verify it now exists and runs (returns 0+ rows, no error):
--     SELECT * FROM claim_next_runnable_job(3);


-- ----------------------------------------------------------------------------
-- [2] (OPTIONAL, only if the queue is already jammed) Reset any job stranded
--     in 'running' by a crashed/401'd invocation, so the queue can drain.
--     Inspect first, then reset if you see stale rows:
-- ----------------------------------------------------------------------------
-- SELECT id, client_id, status, started_at FROM push_jobs WHERE status = 'running';
-- UPDATE push_jobs SET status = 'queued', started_at = NULL
--   WHERE status = 'running' AND started_at < now() - interval '10 minutes';


-- ----------------------------------------------------------------------------
-- [3] GitHub issue #139  —  categories "contains" filter times out (5xx).
--     Root cause: text_contains_matches' array branch uses a correlated EXISTS
--     subquery, which makes the whole SQL function non-inlinable, so it runs as
--     an opaque per-row call over the full companies table -> statement timeout.
--     Fix: replace the EXISTS with ILIKE ANY(text[]) (single ScalarArrayOpExpr),
--     mirroring the fast list_contains_matches path. Semantics unchanged.
--     Source of truth: lib/data/virtual-columns.sql (function text_contains_matches).
--
--     Run this whole block in the Supabase SQL editor:
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION text_contains_matches(text_value text, value jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'array' THEN text_value ILIKE ANY (
      ARRAY(SELECT '%' || kw || '%' FROM jsonb_array_elements_text(value) AS kw)
    )
    ELSE text_value ILIKE ('%' || (value #>> '{}') || '%')
  END
$$;

-- Verify (should return quickly, ~1-2s, no timeout):
--   SELECT count(*) FROM companies
--   WHERE text_contains_matches(categories, '["software"]'::jsonb);


-- ----------------------------------------------------------------------------
-- [4] GitHub issue #137  —  reaper / lease timeout for stranded 'running' jobs.
--     A push job left in 'running' by a crashed/hard-killed invocation blocks
--     that client's queue forever (the per-client `NOT EXISTS running` claim
--     predicate excludes the client), and a few such rows exhaust the global
--     MAX_CONCURRENT_JOBS cap, stalling every client. There was no reaper.
--     Fix: `started_at` now doubles as a lease — claim_next_runnable_job sets it
--     and the worker renews it on every progress tick — and this function resets
--     any 'running' job whose lease has gone stale back to 'queued' (keeping its
--     cursor so a re-claim resumes where it stranded). The worker calls it once
--     at the start of every invocation.
--     Source of truth: lib/data/push-jobs.sql (function reset_stale_running_jobs).
--
--     Run this whole block in the Supabase SQL editor:
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reset_stale_running_jobs(stale_seconds integer DEFAULT 600)
RETURNS SETOF push_jobs
LANGUAGE sql
AS $$
  UPDATE push_jobs
  SET status = 'queued', started_at = NULL
  WHERE status = 'running'
    AND started_at IS NOT NULL
    AND started_at < now() - make_interval(secs => stale_seconds)
  RETURNING *;
$$;

-- Verify it exists and runs (returns the rows it reclaimed, 0+ rows, no error):
--   SELECT id, client_id FROM reset_stale_running_jobs(600);
