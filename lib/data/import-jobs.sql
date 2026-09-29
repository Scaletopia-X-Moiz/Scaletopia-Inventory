-- Run once in the Supabase SQL editor (ticket T22, "Queue on import").
--
-- MUST be applied by hand in the Supabase SQL editor (the local DATABASE_URL
-- password for automated DDL is stale) BEFORE deploying the import worker /
-- enqueue route — both call the table and functions below.
--
-- Turns an import from a request-bound SSE stream (app/api/import/stream) into
-- a durable background job, modelled on push_jobs (see push-jobs.sql and
-- docs/adr/0004-push-job-worker-runtime.md, and docs/adr/0006-import-job-queue.md
-- for why this is a separate table/worker rather than a reuse of push_jobs).
--
-- One `import_jobs` row is ONE CSV imported into one or two target tables
-- (`stages`). The CSV itself lives in the `csv-imports` storage bucket
-- (`storage_path`) until the job is terminal. `cursor` = {stage, offset} is the
-- resume position: the worker re-parses and re-dedupes the CSV each tick and
-- slices the deduped list from `offset`.
CREATE TABLE IF NOT EXISTS import_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status        text NOT NULL DEFAULT 'queued',  -- queued | running | succeeded | failed | partial | canceled
  source_key    text NOT NULL,
  tags          text[] NOT NULL,                  -- [client, niche, date]
  stages        jsonb NOT NULL,                   -- [{targetTable, columnMap}] (1 or 2 entries)
  storage_path  text NOT NULL,                    -- object in the csv-imports bucket
  file_name     text,
  row_count     integer NOT NULL DEFAULT 0,       -- CSV data rows (display)
  cursor        jsonb,                            -- {stage:int, offset:int}
  stage_results jsonb NOT NULL DEFAULT '[]',      -- per stage: {targetTable,inputCount,dedupedCount,inserted,updated,failed,historyId}
  total         integer NOT NULL DEFAULT 0,       -- deduped count of the CURRENT stage
  processed     integer NOT NULL DEFAULT 0,       -- offset within the CURRENT stage
  inserted      integer NOT NULL DEFAULT 0,       -- running totals, current stage
  updated       integer NOT NULL DEFAULT 0,
  failed        integer NOT NULL DEFAULT 0,
  failed_records jsonb NOT NULL DEFAULT '[]',     -- current stage, capped by the worker (MAX_FAILED_RECORDS_KEPT)
  error         text,
  triggered_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  triggered_by_email   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,                      -- lease (see claim / reset_stale below)
  finished_at   timestamptz
);

CREATE INDEX IF NOT EXISTS import_jobs_status_created_idx ON import_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS import_jobs_created_idx        ON import_jobs (created_at DESC);

-- Links each import_history row back to the job that produced it. Nullable:
-- rows written by the legacy stream route (and every row that predates this
-- migration) keep it NULL. ON DELETE SET NULL so pruning jobs never touches
-- history. Additive only — no existing column or row changes.
ALTER TABLE import_history
  ADD COLUMN IF NOT EXISTS import_job_id uuid REFERENCES import_jobs(id) ON DELETE SET NULL;

-- Atomic global claim.
--
-- Picks the oldest `queued` import job, but ONLY when no import job is
-- already `running` — a global mutex, independent of push_jobs. Imports are
-- serialized because the app classifies insert-vs-update against an in-memory
-- snapshot of existing keys and there is no upsert; two imports running at
-- once could both classify the same record as new and insert duplicates
-- (companies.linkedin_url and people.email have no unique constraint).
--
-- claim_next_runnable_job's mutex-equivalent (its per-client NOT EXISTS) is
-- only best-effort under FOR UPDATE SKIP LOCKED: two simultaneous claimers can
-- both see "nothing running". Here that would be the exact data-integrity risk
-- the design avoids, so the whole body runs under a transaction-scoped
-- advisory lock — the second claimer waits, then sees the first's `running`
-- row and returns nothing. That needs plpgsql (a plain sql function can't
-- take the lock before evaluating the predicate).
--
-- Returns 0 rows when nothing is runnable. Only ever claims `queued` jobs;
-- resuming a `running` job is the worker's job (it self-chains by id).
-- `started_at` is set here and doubles as the job's lease.
CREATE OR REPLACE FUNCTION claim_next_import_job()
RETURNS SETOF import_jobs
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('import_jobs_claim'));

  RETURN QUERY
  UPDATE import_jobs
  SET status = 'running', started_at = now()
  WHERE id = (
    SELECT j.id
    FROM import_jobs j
    WHERE j.status = 'queued'
      AND NOT EXISTS (
        SELECT 1 FROM import_jobs r WHERE r.status = 'running'
      )
    ORDER BY j.created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
END;
$$;

-- Lease timeout / reaper. Copy of reset_stale_running_jobs against import_jobs.
--
-- A job stranded in `running` by a crashed or hard-killed invocation would
-- otherwise hold the global mutex forever and block every queued import. This
-- resets any `running` job whose lease (`started_at`, renewed on progress and
-- by the worker heartbeat) has gone stale back to `queued`, clearing
-- `started_at`. The row keeps its `cursor`, so a re-claim resumes where it
-- stranded. The worker calls this at the start of every invocation.
--
-- Default 360s (push uses 60s): must exceed the worker route's maxDuration
-- (300s) so a live invocation is never reaped. The worker also renews the lease
-- every 30s for the whole tick. Keep in sync with IMPORT_JOB_STALE_SECONDS in
-- lib/data/import-jobs.ts.
CREATE OR REPLACE FUNCTION reset_stale_import_jobs(stale_seconds integer DEFAULT 360)
RETURNS SETOF import_jobs
LANGUAGE sql
AS $$
  UPDATE import_jobs
  SET status = 'queued', started_at = NULL
  WHERE status = 'running'
    AND started_at IS NOT NULL
    AND started_at < now() - make_interval(secs => stale_seconds)
  RETURNING *;
$$;
