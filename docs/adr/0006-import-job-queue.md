# Imports are queued, resumable jobs with their own table and worker

## Context

`POST /api/import/stream` ran an entire import inside one request: parse the
CSV, `pushRecords()`, stream SSE progress. The user had to keep the Import
wizard open until it finished, could not start a second import meanwhile, and
any import past the ~300s `maxDuration` was killed partway (BUG E only recorded
the partial counts; it never resumed). A company-sync import was two
back-to-back SSE calls driven by the browser, so closing the tab between stages
lost stage 2.

Ticket T22 asks for the same queue the push activity got (docs/adr/0004-push-job-worker-runtime.md).

## Decision

Confirming an import **enqueues** an `import_jobs` row and returns `{ jobId }`;
a cron-backed, self-chaining Next route (`app/api/internal/import-worker`)
processes it in resumable ticks. The mechanics mirror the push worker
(`after()` self-chain, cron backstop, `started_at` lease + reaper); the
differences are below.

- **Separate table and worker, not `push_jobs`.** `push_jobs` is shaped around a
  client and a filter snapshot (`client_id NOT NULL`, `filters`), and its claim
  function would serialize imports against pushes. Imports and pushes must
  neither block nor be blocked by each other.
- **Global serialization: one running import at a time.** The app classifies a
  record as insert or update against an in-memory snapshot of existing keys and
  there is no upsert; `companies.linkedin_url` and `people.email` have no unique
  constraint, so two imports running at once could each classify the same
  record as new and insert duplicates. `claim_next_import_job()` therefore
  claims the oldest `queued` job only when no import job is `running`, under
  `pg_advisory_xact_lock` (plpgsql) so two simultaneous claimers cannot both
  win. "Process multiple imports at once" is delivered as *queue many without
  waiting*, not parallel execution; real parallelism would need DB-level upserts
  on every dedupe key and is out of scope.
- **Re-parse and re-dedupe, then slice by offset.** The CSV is kept in the
  existing `csv-imports` bucket (every import, not just large ones) until the
  job reaches a terminal state, never deleted per tick. Each tick re-downloads,
  re-parses and re-runs `applyColumnMap` -> normalize -> dedupe (deterministic
  and order-preserving), then processes `deduped[cursor.offset…]` in chunks of
  `IMPORT_TICK_CHUNK` (2000) until the tick deadline. Existing keys are fetched
  once per tick and updated in memory with each chunk's inserts. The core is
  `runImportTick` in `lib/import/push.ts`; `pushRecords` is now a thin wrapper
  over it (no deadline) so the legacy route and its tests are unchanged.
- **Company sync is one job with ordered stages.** `stages` is
  `[companies, people]` and `cursor = { stage, offset }`. Stage 2 cannot start
  until stage 1 has finished and committed, preserving the ordering people's
  `fetchCompanyIdByDomain` depends on, and surviving a closed tab.
- **Lease / reaper.** Same idea as push, but the stale window is 360s rather
  than 60s: the per-tick existing-keys fetch over ~305k companies can run for
  tens of seconds before the first heartbeat.
- **`import_history` is unchanged for readers.** The worker writes exactly one
  row per finished stage (plus a nullable `import_job_id` back-reference), so
  the History tab and `/api/import/history` keep working.

## Consequences

- Crash recovery is at-least-once per chunk, and a rerun is at most one chunk
  (the cursor is saved after each chunk). Rows with a lookup key (domain /
  linkedin_url for companies, email / linkedin_url for people) are re-applied as
  updates on a rerun (COALESCE / source-union semantics make that safe), so
  `inserted`/`updated` can drift slightly toward "updated". **Keyless rows are
  NOT idempotent**: a company with only `company_name`, or a person with only a
  name, can never match the existing-keys set, so rerunning the crashed chunk
  inserts them again (duplicates). A real fix needs a unique key or an upsert;
  this is a known limitation.
- Bookkeeping failures (progress/advance/finish write, transient storage read)
  never fail the job: it is left `running` with its CSV, and the reaper resumes
  it from the last saved cursor once the lease goes stale. Only a definite
  storage not-found fails the job for missing CSV. The CSV is deleted only
  after the terminal write succeeded.
- Resumability assumes the CSV, column map and normalize/dedupe code don't
  change mid-job. A deploy that changes normalize/dedupe while a job is running
  could shift offsets; accepted.
- `failed_records` on the job and in `import_history` is now capped (5000 per
  stage, with a truncation marker); `failed` carries the true count.
- `app/api/import/stream` stays deployed, unused by the UI, as a rollback path.
  It bypasses the mutex; removing it is a follow-up.
- The `canceled` status exists but has no UI yet.
