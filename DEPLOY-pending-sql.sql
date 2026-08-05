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
