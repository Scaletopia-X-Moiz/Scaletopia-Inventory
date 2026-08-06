-- Run once in the Supabase SQL editor (ticket #119, "push_jobs schema").
--
-- Foundation for turning GHL/EmailBison pushes from an ephemeral SSE stream
-- into a durable background job (epic #118). `push_jobs` is the queue row
-- itself: it carries its own progress (total/processed/succeeded/failed,
-- driving the live progress bar), its terminal result (failures, error),
-- and the trigger-time filter/options snapshot needed to resume or audit
-- the run. Columns mirror the shapes the routes already produce today —
-- `total/succeeded/failed/failures` match `EmailBisonPushResult`
-- (lib/emailbison/push-to-emailbison.ts) and the GHL push result;
-- `processed` is what today's `onProgress({done,total})` reports.
--
-- `push_job_records` tags each pushed person with the job that pushed
-- them, so "View Contacts" can filter to exactly one run's records.
-- `platform_pushes` (see platform-pushes.sql) upserts on
-- (person_id, client_id, platform) and would overwrite across repeat runs,
-- so the per-run link is recorded separately here instead of overloading
-- that table.
CREATE TABLE IF NOT EXISTS push_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id     uuid NOT NULL REFERENCES clients(id),
  -- "ghl" | "emailbison_people" | "emailbison_companies" | "emailbison_campaign"
  -- (same platform vocabulary push_field_mappings uses; distinguishes entity + action)
  platform      text NOT NULL,
  entity        text NOT NULL,              -- "people" | "companies" (trigger surface)
  action        text,                       -- "workspace" | "campaign" (emailbison only)
  campaign_id   text,                       -- emailbison campaign action only
  niche         text[],                     -- captured from the trigger-time niche filter (may be empty)
  filters       jsonb NOT NULL,             -- trigger-time filter snapshot (the query string) — audit + niche derivation
  options       jsonb NOT NULL DEFAULT '{}',-- existingLeadBehavior, customVariables, standardFieldMapping, parallel
  status        text NOT NULL DEFAULT 'queued', -- queued | running | succeeded | failed | partial | canceled
  total         integer NOT NULL DEFAULT 0, -- records selected (resolved at claim time)
  processed     integer NOT NULL DEFAULT 0, -- records attempted so far (drives the progress bar)
  succeeded     integer NOT NULL DEFAULT 0, -- created-or-updated / attached
  failed        integer NOT NULL DEFAULT 0,
  failures      jsonb NOT NULL DEFAULT '[]',-- [{name, reason}] — same shape as EmailBisonPushFailure, capped
  cursor        jsonb,                       -- resume position for chunked processing (see runner issue)
  error         text,                        -- terminal error message when status=failed
  triggered_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  triggered_by_email   text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  finished_at   timestamptz
);

CREATE INDEX IF NOT EXISTS push_jobs_status_created_idx ON push_jobs (status, created_at);
CREATE INDEX IF NOT EXISTS push_jobs_client_idx        ON push_jobs (client_id, created_at DESC);

-- Atomic per-client claim (ticket #121, "queueing / serialization").
--
-- Picks the oldest `queued` job whose client has no job already `running`,
-- flips it to `running`, and returns it — all in one statement so two
-- concurrent worker ticks can never claim the same row (`FOR UPDATE SKIP
-- LOCKED` on the candidate). The `NOT EXISTS (running for this client)`
-- predicate is the whole serialization rule: rate limits are per EmailBison
-- workspace / GHL location (i.e. per client), so a second push to the *same*
-- client must queue behind the first, while two *different* clients' pushes
-- may run at once. "Auto-start when the current completes" falls out for free:
-- once the running job goes terminal its client is no longer `running`, so the
-- next tick claims the now-unblocked queued job.
--
-- `max_concurrent` is an optional soft cap on total running jobs across all
-- clients, so a burst of many-client pushes doesn't spin up unboundedly many
-- overlapping worker invocations. NULL disables the cap. It is best-effort:
-- concurrent claimers each see the pre-claim count under SKIP LOCKED, so the
-- live total can briefly exceed the cap by the number of simultaneous
-- claimers — fine for a soft throttle on an internal tool.
--
-- Returns 0 rows when nothing is runnable (all queued clients busy, or the cap
-- is hit). Only ever claims `queued` jobs — resuming a `running` job left by a
-- timed-out invocation is the worker's job (it self-chains by id), not this
-- function's.
--
-- `started_at` is set to now() here at claim time and doubles as the job's
-- lease: the worker renews it on every progress tick (updateJobProgress), so a
-- healthy multi-tick job keeps it fresh while a crashed invocation stops
-- renewing it. `reset_stale_running_jobs` (below) reaps rows whose lease has
-- gone cold.
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

-- Lease timeout / reaper (ticket #137).
--
-- A job stranded in `running` by a crashed or hard-killed invocation (one that
-- died before its try/catch could mark it failed) would otherwise block its
-- client's queue forever — the per-client `NOT EXISTS running` predicate in
-- claim_next_runnable_job permanently excludes that client — and a few such
-- rows also exhaust the global MAX_CONCURRENT_JOBS cap, stalling every client.
-- The `after()` self-chain that normally resumes a running job is best-effort
-- and `.catch`-swallowed, so nothing reclaims the row on its own (see
-- docs/adr/0004-push-job-worker-runtime.md).
--
-- This resets any `running` job whose lease has gone stale — `started_at` is
-- renewed on every progress tick, so a job that hasn't advanced it within
-- `stale_seconds` is presumed dead — back to `queued`, clearing `started_at`.
-- The row keeps its `cursor`, so a re-claim resumes from where it stranded
-- rather than restarting (push_job_records' (job, person) PK keeps that
-- idempotent). The worker calls this once at the start of every invocation, so
-- a stranded job is auto-recovered within ~one cron minute of its lease
-- lapsing. The default lease (600s / 10 min) is comfortably above the worker's
-- ~4.5-min per-invocation budget, so a healthy job spanning several
-- self-chained invocations is never reaped mid-flight.
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

CREATE TABLE IF NOT EXISTS push_job_records (
  push_job_id uuid NOT NULL REFERENCES push_jobs(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES people(id),
  outcome     text NOT NULL,   -- "succeeded" | "failed"
  PRIMARY KEY (push_job_id, person_id)
);
CREATE INDEX IF NOT EXISTS push_job_records_person_idx ON push_job_records (person_id);
