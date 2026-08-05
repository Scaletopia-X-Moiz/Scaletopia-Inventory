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

CREATE TABLE IF NOT EXISTS push_job_records (
  push_job_id uuid NOT NULL REFERENCES push_jobs(id) ON DELETE CASCADE,
  person_id   uuid NOT NULL REFERENCES people(id),
  outcome     text NOT NULL,   -- "succeeded" | "failed"
  PRIMARY KEY (push_job_id, person_id)
);
CREATE INDEX IF NOT EXISTS push_job_records_person_idx ON push_job_records (person_id);
