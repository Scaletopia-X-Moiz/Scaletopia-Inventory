# Push job worker is a Next route, self-chained with a cron backstop

## Context

Both push triggers (`app/api/emailbison/push`, `app/api/people/push-to-ghl`)
used to run the entire push inline inside an SSE `ReadableStream`, holding the
dialog open for the whole run. That has two problems the epic (#118) calls out:
`maxDuration = 300` kills a large push mid-run at the ~5-minute Vercel cap, and
nothing is persisted mid-run — close the tab and all visibility is lost.

Issue #119 landed the durable store (`push_jobs` + `push_job_records`). Issue
#120 is the runner: triggers become enqueue-only (`{ jobId }`, not SSE), and a
background worker claims jobs and processes them in **resumable ticks** so no
single invocation owns a large push.

The open decision (#120, #118 notes): a **Supabase Edge Function** re-importing
the push core, or a **Next route** invoked by cron. The push core lives in
`lib/emailbison/push-to-emailbison.ts` and `lib/ghl/push-to-ghl.ts` — thousands
of lines of chunking, concurrency, custom-variable ensure, `platform_pushes`
write-back, and failure-reason capture.

## Decision

**The worker is a Next route** at `app/api/internal/push-worker/route.ts`, not a
Supabase Edge Function.

- **Reuse over re-port.** A Next route calls the existing TS push core directly.
  An Edge Function would mean porting (or dual-maintaining) that whole core into
  the Deno/Edge runtime — the single biggest thing this issue was told not to
  do. Everything stays in `lib/`.
- **Self-chaining + cron backstop.** The route exports both `GET` (Vercel Cron
  only issues GET) and `POST` (self-chain and route-triggered kicks), both
  running the same tick loop. When an invocation exhausts its wall-clock budget
  with work still outstanding, it fires an unawaited `fetch` back to its own
  route via `after()` from `next/server` (survives past the response without
  blocking it), so a large push spans invocations without waiting for the next
  cron minute. A **Vercel Cron** entry (`vercel.json`, `* * * * *` — the
  1-minute minimum) is the reliability net if a self-chain is ever dropped.
- **Immediate kick.** Each enqueue route also `after()`-fetches the worker once,
  so a push starts within a second of triggering rather than on the next cron
  minute.
- **Optional secret.** Security is explicitly not a priority for this internal
  team tool (#118). The route checks `Authorization: Bearer $CRON_SECRET`
  (Vercel's automatic cron header) and `x-worker-secret: $PUSH_WORKER_SECRET`
  (our own kicks), but **skips the check entirely when neither env var is set**
  — dev-friendly, no config required to run locally.

### Tick / resumability model

- **Re-resolve-and-offset, not a persisted candidate list.** Each tick
  re-resolves candidates from the job's stored filter snapshot (a deterministic
  query — same filters, same underlying data mid-run) and slices from
  `cursor.offset`, rather than persisting the whole candidate set on the row.
  `push_job_records` (PK `(job, person)`) makes a re-reported chunk idempotent,
  and `cursor` is only advanced after a chunk group's write-back succeeds, so a
  crash mid-tick never double-counts.
- **Tick boundary style differs by push shape.** EmailBison workspace-push and
  GHL push check a wall-clock `deadline` (epoch ms) between chunk/concurrency
  groups. EmailBison campaign-push is a single bulk `attachLeadsToCampaign` call
  with no internal boundary to check a deadline against, so it's bounded by a
  fixed candidate-count cap per tick (`EMAILBISON_CAMPAIGN_TICK_SIZE = 2000`)
  instead.
- **Budgets.** One invocation runs a ~4.5-minute wall-clock loop (safely under
  the 300s cap, leaving headroom for write-backs and the self-chain), handing a
  per-tick `deadline` of up to 4 minutes (capped by the invocation's own
  deadline). Running totals are seeded from the job row and advanced per tick;
  the persisted `failures` array is capped at 50 entries.

## Consequences

- No new runtime to maintain; the push core has exactly one implementation.
- The worker inherits the Next route's `maxDuration` — resumability, not a
  longer single invocation, is what lets a push exceed it.
- **Deferred to #121 (queueing/serialization):** the worker claims jobs
  **global FIFO, one running job at a time** (`getResumableJob` →
  `claimNextQueuedJob`). Per-client serialization (letting two different
  clients' pushes run concurrently while a second push to the *same* client
  queues) is #121; it refines the claim predicate in `lib/data/push-jobs.ts`
  without touching the worker. This decision doesn't preclude it.
- **Deferred to #122 (Push Activity panel):** the push buttons keep working via
  a minimal polling shim (`pollJob` → `GET /api/push-jobs/[id]`), but the
  completion summary is now generic (succeeded / failed / total, plus failure
  names+reasons) rather than the old per-platform breakdown
  (created / tag-appended / skipped for GHL; attached for campaign). The durable
  `push_jobs` row doesn't carry those distinctions; #122's panel restores them.
