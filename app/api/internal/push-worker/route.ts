import { after } from "next/server";
import {
  claimNextRunnableJob,
  resetStaleRunningJobs,
  getPushJob,
  updateJobProgress,
  touchJobLease,
  finishJob,
  recordJobPeople,
  updateJobOptions,
  listMarkedActivityJobs,
  claimActivityJobMarker,
  type PushJob,
  type PushJobStatus,
  type PushJobFailure,
} from "@/lib/data/push-jobs";
import { getClientById } from "@/lib/data/clients";
import { logActivity } from "@/lib/activity/log";
import {
  runPeopleAddToEmailBison,
  runCompaniesAddToEmailBison,
  runPeopleAddToCampaign,
  runCompaniesAddToCampaign,
} from "@/lib/emailbison/push-to-emailbison";
import { resumeCampaign } from "@/lib/emailbison/client";
import { runPeopleGhlPush } from "@/lib/ghl/push-to-ghl";
import { runGhlActivitySync } from "@/lib/ghl/sync-activity";
import { enqueueGhlActivitySync } from "@/lib/ghl/enqueue-activity-sync";
import {
  BUDGET_STOP_OPTION_KEY,
  FAILURE_RETRY_OPTION_KEY,
  INCREMENTAL_QUEUE_JOB_ID,
  budgetStopMarkerFrom,
  droppedRemainderMessage,
  failureRetryMarkerFrom,
  hasIrreplaceableWorkList,
  isResumableOn,
  isRetryDueAt,
  MAX_ACTIVITY_RETRY_ATTEMPTS,
  ownsQueuePartition,
  planActivityFailureRetry,
  queueJobIdFor,
  retryAttemptsSpent,
  scopeFromJobOptions,
  type ActivityBudgetStopMarker,
} from "@/lib/ghl/activity-scope";
import { budgetDay } from "@/lib/ghl/activity-budget";
import { clearActivityQueueForJob, countActivityQueue } from "@/lib/data/ghl-activity";
import { errorMessage } from "@/lib/errors";
import type { PersonListFilters } from "@/lib/data/people";
import type { CompanyListFilters } from "@/lib/data/companies";
import type { EmailBisonCustomVariableEntry, EmailBisonStandardFieldMapping } from "@/lib/emailbison/types";
import type { GhlStandardFieldMapping } from "@/lib/ghl/types";
import { normalizeGhlFieldMapping } from "@/lib/ghl/field-mapping";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Overall wall-clock budget for one worker invocation. Kept safely under the
 * 300s serverless cap so finishJob/updateJobProgress write-backs, plus the
 * self-chain `after` fetch, always have headroom before the platform kills
 * the invocation. */
const WORKER_BUDGET_MS = 270_000;
/** Deadline handed to a single push-core tick — the core stops after the
 * chunk/concurrency group in flight once this passes, returning the offset to
 * resume from. Capped by the worker budget so a tick never runs past the
 * invocation's own deadline. */
const TICK_BUDGET_MS = 240_000;
/** Cap on the `failures` array persisted to the job row — the jsonb column
 * would otherwise grow unbounded across ticks of a large, failure-heavy run.
 * Raised from 50 (confirmed live: a 100-failure job only surfaced 50 reasons
 * in the Push Activity panel) to 500 — comfortably above any single push
 * batch's realistic failure count while still bounding jsonb growth on a
 * pathological all-failed run. */
const MAX_FAILURES_KEPT = 500;

/** Soft cap on how many jobs may be `running` at once across all clients
 * (ticket #121). Per-client serialization already keeps one client to a single
 * running job; this bounds the *total* so a burst of many-client pushes can't
 * spin up unboundedly many overlapping worker invocations. Passed to the claim
 * query, which treats it as best-effort. */
const MAX_CONCURRENT_JOBS = 3;

const WORKER_PATH = "/api/internal/push-worker";

/** Optional shared-secret gate. Security is explicitly not the priority for
 * this internal team tool (epic #118) — if neither secret env var is set the
 * check is skipped entirely (dev-friendly). CRON_SECRET matches Vercel Cron's
 * automatic `Authorization: Bearer` header; PUSH_WORKER_SECRET matches the
 * `x-worker-secret` header on our own self-chain / route-triggered kicks. */
function authorized(request: Request): boolean {
  // Trust genuine Vercel cron invocations directly, so the worker doesn't
  // depend on the CRON_SECRET bearer handshake (which silently 401'd the queue
  // when the secret value didn't match). Vercel cron requests carry the
  // `x-vercel-cron-schedule` header and a `vercel-cron/*` User-Agent.
  const ua = request.headers.get("user-agent") ?? "";
  if (
    request.headers.get("x-vercel-cron") ||
    request.headers.get("x-vercel-cron-schedule") ||
    ua.startsWith("vercel-cron")
  ) {
    return true;
  }
  const cronSecret = process.env.CRON_SECRET;
  const workerSecret = process.env.PUSH_WORKER_SECRET;
  if (!cronSecret && !workerSecret) return true;
  if (cronSecret && request.headers.get("authorization") === `Bearer ${cronSecret}`) return true;
  if (workerSecret && request.headers.get("x-worker-secret") === workerSecret) return true;
  return false;
}

/** Header set on our own worker→worker self-chain fetch, so a configured
 * PUSH_WORKER_SECRET still lets the chained invocation through. */
function selfChainHeaders(): Record<string, string> {
  const workerSecret = process.env.PUSH_WORKER_SECRET;
  return workerSecret ? { "x-worker-secret": workerSecret } : {};
}

/** Builds the mid-tick lease heartbeat handed to each push core as
 * `onProgress`. A push core fires onProgress once per concurrency group, which
 * can be many times a second on a large batch — so this throttles the actual
 * DB write to at most once per `minIntervalMs` and never overlaps two writes.
 * Fire-and-forget: a failed heartbeat is logged, never thrown, so it can't
 * abort the push. Renewing `started_at` this often is what lets the reaper's
 * stale window sit at ~2 min without ever mistaking a live tick for a dead one
 * (see touchJobLease / resetStaleRunningJobs). Ignores its progress argument —
 * a bare `() => void` is assignable to every core's typed onProgress. */
function makeJobHeartbeat(jobId: string, minIntervalMs = 20_000): () => void {
  let lastAt = 0;
  let inFlight = false;
  return () => {
    const now = Date.now();
    if (inFlight || now - lastAt < minIntervalMs) return;
    lastAt = now;
    inFlight = true;
    touchJobLease(jobId)
      .catch((err) => {
        console.error(`[push-worker] lease heartbeat failed (jobId=${jobId}): ${errorMessage(err)}`);
      })
      .finally(() => {
        inFlight = false;
      });
  };
}

interface TickOutcome {
  total: number;
  nextOffset: number;
  done: boolean;
  /** New records this tick pushed for the first time (no prior platform_pushes
   * row) vs. records that already had one — the created/updated split
   * (feedback item 2b), accumulated across ticks in processJobTick. */
  created: number;
  updated: number;
  succeededPersonIds: string[];
  failedPersonIds: string[];
  failures: PushJobFailure[];
  /** Set when the tick stopped for a condition that will still hold on the
   * next tick — today only the per-location daily GHL API budget. Such a job
   * must NOT be self-chained: it cannot advance until the UTC day rolls over,
   * and chaining it would spin the worker. Treated as terminal, with the
   * reason on the job row so a human sees it. */
  stoppedReason?: string | null;
}

/** Dispatches one tick to the right push-core function based on the job's
 * platform/entity/action, normalizing each core's result into TickOutcome.
 * Filters are re-resolved from the stored snapshot inside each core every
 * tick (deterministic query) and sliced by `offset` — the resumability model
 * documented on RunEmailBisonPushDeps/RunGhlPushDeps. */
async function runTick(
  job: PushJob,
  client: Awaited<ReturnType<typeof getClientById>>,
  actor: { id: string; email: string },
  offset: number,
  deadline: number
): Promise<TickOutcome> {
  if (!client) throw new Error(`Client ${job.clientId} not found`);

  const options = job.options ?? {};

  // Heartbeat the job's lease from each core's onProgress so a live multi-tick
  // push keeps `started_at` fresh (see makeJobHeartbeat / resetStaleRunningJobs).
  const heartbeat = makeJobHeartbeat(job.id);

  if (job.platform === "ghl") {
    const result = await runPeopleGhlPush(job.filters as unknown as PersonListFilters, client, actor, {
      offset,
      deadline,
      onProgress: heartbeat,
      // normalizeGhlFieldMapping (ticket #142) upgrades a job queued before
      // the #142 deploy (legacy {virtualColumnKey, ghlFieldId} entries)
      // instead of the blind cast silently misreading it.
      fieldMapping: normalizeGhlFieldMapping(options.fieldMapping),
      standardFieldMapping: options.standardFieldMapping as GhlStandardFieldMapping | undefined,
      customTagSuffix: options.customTagSuffix as string | null | undefined,
    });
    return {
      total: result.total_matched,
      nextOffset: result.nextOffset,
      done: result.done,
      created: result.created ?? 0,
      updated: result.updated ?? 0,
      succeededPersonIds: result.succeededPersonIds,
      failedPersonIds: result.failedPersonIds,
      // GhlPushResult now carries a concrete per-record reason (feedback item
      // 2c), so surface that instead of a generic whole-batch message. Fall
      // back to the name-only shape if `failed` is absent (defensive).
      failures: result.failed
        ? result.failed
        : result.failed_people.map((name) => ({ name, reason: "GHL push failed — see server logs" })),
    };
  }

  // GHL last-activity sync (docs/features/ghl-last-activity/handoff.md §14).
  // Extends this dispatch rather than standing up a parallel queue: the sync
  // is rate-limited against the *same* GHL location as a push to the same
  // client, so it must share push_jobs' per-client serialization
  // (claim_next_runnable_job's NOT EXISTS predicate) — a separate queue would
  // happily run a sync and a push at the same location concurrently and eat
  // each other's 100-req/10s burst budget. It also inherits the reaper, the
  // lease heartbeat, the self-chain and the Push Activity panel for free.
  //
  // Unlike the push cores it takes no filter snapshot: its working set is
  // "every contact this client has a platform_contact_id for", which is a
  // property of the client, not of the view the user was looking at.
  if (job.platform === "ghl_activity") {
    const result = await runGhlActivitySync(client, {
      offset,
      deadline,
      onProgress: heartbeat,
      full: options.full === true,
      // The queue partition this job owns. A targeted job keeps its work list
      // to itself; a whole-client job joins the shared incremental queue (the
      // all-zero sentinel), which is what `queueJobIdFor` decides from the
      // scope. Passing job.id unconditionally would split the incremental
      // queue per job and lose its across-runs resume cursor.
      jobId: job.id,
      scope: scopeFromJobOptions(options),
      dedupedOnly: options.dedupedOnly === true,
    });
    return {
      total: result.total,
      nextOffset: result.nextOffset,
      done: result.done,
      // "created" is reused as "contacts whose last activity actually moved"
      // and "updated" as "contacts the incremental path skipped" — the two
      // numbers worth seeing in the Push Activity panel for a sync, carried on
      // the columns that already exist rather than adding sync-only ones.
      created: result.updated,
      updated: result.skipped,
      succeededPersonIds: result.succeededPersonIds,
      failedPersonIds: result.failedPersonIds,
      failures: result.failed,
      stoppedReason: result.stoppedReason,
    };
  }

  if (job.platform === "emailbison_people" || job.platform === "emailbison_companies") {
    const deps = {
      offset,
      deadline,
      onProgress: heartbeat,
      existingLeadBehavior: options.existingLeadBehavior as "patch" | "put" | undefined,
      customVariables: options.customVariables as EmailBisonCustomVariableEntry[] | undefined,
      standardFieldMapping: options.standardFieldMapping as EmailBisonStandardFieldMapping | undefined,
    };
    const result =
      job.platform === "emailbison_people"
        ? await runPeopleAddToEmailBison(job.filters as unknown as PersonListFilters, client, actor, deps)
        : await runCompaniesAddToEmailBison(job.filters as unknown as CompanyListFilters, client, actor, deps);
    return {
      total: result.total_matched,
      nextOffset: result.nextOffset,
      done: result.done,
      created: result.created ?? 0,
      updated: result.updated ?? 0,
      succeededPersonIds: result.succeededPersonIds,
      failedPersonIds: result.failedPersonIds,
      failures: result.failed,
    };
  }

  if (job.platform === "emailbison_campaign") {
    if (!job.campaignId) throw new Error(`Campaign job ${job.id} has no campaignId`);
    const deps = {
      offset,
      deadline,
      onProgress: heartbeat,
      existingLeadBehavior: options.existingLeadBehavior as "patch" | "put" | undefined,
      customVariables: options.customVariables as EmailBisonCustomVariableEntry[] | undefined,
      standardFieldMapping: options.standardFieldMapping as EmailBisonStandardFieldMapping | undefined,
      parallel: options.parallel as boolean | undefined,
    };
    const result =
      job.entity === "people"
        ? await runPeopleAddToCampaign(
            job.filters as unknown as PersonListFilters,
            client,
            job.campaignId,
            actor,
            deps
          )
        : await runCompaniesAddToCampaign(
            job.filters as unknown as CompanyListFilters,
            client,
            job.campaignId,
            actor,
            deps
          );
    return {
      total: result.total_matched,
      nextOffset: result.nextOffset,
      done: result.done,
      created: result.created ?? 0,
      updated: result.updated ?? 0,
      succeededPersonIds: result.succeededPersonIds,
      failedPersonIds: result.failedPersonIds,
      failures: result.failed,
    };
  }

  throw new Error(`Unknown push job platform "${job.platform}"`);
}

/** Drops the queue rows a terminal job will never drain.
 *
 * Only a job that owns a private partition has any: the shared incremental
 * partition's rows ARE its across-runs resume cursor and must never be
 * cleared here. A private partition belongs to one job and nothing else will
 * ever claim it, so leaving it behind leaks rows forever — up to
 * MAX_FILTERED_PEOPLE of them for a pre-queued job, which is why this runs on
 * every terminal path rather than only the budget stop it was written for.
 *
 * NOT on a budget stop any more, and that is the point: a budget stop is
 * "come back tomorrow", so its remainder is kept and marked for resume
 * (`markActivityJobForResume`). Every other terminal path really is the end
 * of that work — the job failed or finished, and nothing will claim the
 * partition again. */
async function discardPrivateQueuePartition(job: PushJob): Promise<void> {
  const partition = privateQueuePartitionOf(job);
  if (!partition) return;
  await clearActivityQueueForJob(job.clientId, partition).catch((err) => {
    console.error(`[push-worker] failed to clear activity queue for terminal job ${job.id}: ${errorMessage(err)}`);
  });
}

/** The `ghl_activity_queue` partition this job owns, or null when it has none
 * of its own (not an activity job, or a plain incremental run drinking from
 * the shared sentinel partition). Not always `job.id`: a continuation job
 * adopts the partition of the job the daily budget stopped. */
function privateQueuePartitionOf(job: PushJob): string | null {
  if (job.platform !== "ghl_activity") return null;
  const scope = scopeFromJobOptions(job.options);
  const full = job.options?.full === true;
  if (!ownsQueuePartition(scope, full)) return null;
  const partition = queueJobIdFor(job.id, scope, full);
  return partition === INCREMENTAL_QUEUE_JOB_ID ? null : partition;
}

/** The partition this job owns AND cannot reconstruct if it is thrown away —
 * see `hasIrreplaceableWorkList` for which kinds those are and why.
 *
 * Null for the SHARED sentinel partition by construction: it comes through
 * `privateQueuePartitionOf`, which returns null for it. The sentinel is the
 * client's across-runs incremental cursor — never discarded, never adopted. */
function adoptableQueuePartitionOf(job: PushJob): string | null {
  const partition = privateQueuePartitionOf(job);
  if (!partition) return null;
  const scope = scopeFromJobOptions(job.options);
  return hasIrreplaceableWorkList(scope, job.options?.full === true) ? partition : null;
}

/** Decides what a job that threw for an unexpected reason does with its
 * undrained queue partition, and what its row should say.
 *
 * The defect this closes: the worker's generic catch used to call
 * `discardPrivateQueuePartition` unconditionally, so one transient
 * `Timed out acquiring connection from connection pool` (handoff §14.5.8)
 * permanently destroyed the remainder of a filtered refresh of up to
 * MAX_FILTERED_PEOPLE people — rows that are the ONLY record of that work.
 *
 * Three outcomes, and the invariant across all of them is that the partition
 * is either adopted by a retry or discarded, never left behind unclaimed
 * (rows nothing will ever look for again are a leak, not a safety net):
 *
 *   retry pending — marker written, partition kept, caller must NOT discard.
 *   exhausted     — attempts spent; caller discards and the row says plainly
 *                   that the remainder was dropped and how big it was.
 *   not adoptable — an ids/full/incremental job, or an already-empty
 *                   partition. Behaves exactly as before.
 *
 * Returns the error text for the job row and whether a retry now owns the
 * rows. Best-effort throughout: anything that goes wrong while arranging the
 * retry degrades to "discard and say so", because a remainder nothing is
 * coming back for must not be left sitting in the queue pretending otherwise. */
async function planFailureForActivityJob(
  job: PushJob,
  reason: string
): Promise<{ error: string; retryPending: boolean }> {
  if (job.platform !== "ghl_activity") return { error: reason, retryPending: false };

  const partition = adoptableQueuePartitionOf(job);
  if (!partition) return { error: reason, retryPending: false };

  let remaining: number;
  try {
    remaining = await countActivityQueue(job.clientId, partition);
  } catch (err) {
    console.error(
      `[push-worker] could not count the remainder of failed job ${job.id}: ${errorMessage(err)}`
    );
    return { error: reason, retryPending: false };
  }
  // Nothing left to protect — the job drained its work and then threw.
  if (remaining === 0) return { error: reason, retryPending: false };

  const plan = planActivityFailureRetry({
    reason,
    queueJobId: partition,
    remaining,
    spent: retryAttemptsSpent(job.options),
  });
  if (plan.outcome === "exhausted") return { error: plan.error, retryPending: false };

  try {
    await updateJobOptions(job.id, { ...job.options, [FAILURE_RETRY_OPTION_KEY]: plan.marker });
  } catch (err) {
    // The marker is the ONLY thing that would ever bring a worker back to
    // these rows. Without it they are invisible, so the honest move is to drop
    // them and say so rather than leak them silently.
    console.error(
      `[push-worker] could not mark job ${job.id} for failure retry: ${errorMessage(err)}`
    );
    return { error: droppedRemainderMessage(reason, remaining), retryPending: false };
  }
  console.warn(
    `[push-worker] job ${job.id} failed with ${remaining} contacts left in partition ${partition}; ` +
      `retry ${plan.marker.attempt} of ${MAX_ACTIVITY_RETRY_ATTEMPTS} scheduled: ${reason}`
  );
  return { error: plan.error, retryPending: true };
}

/** Records that the daily GHL budget stopped this job with work still in its
 * partition, so a later invocation can hand that remainder to a fresh job.
 *
 * The rows are deliberately NOT discarded. For a filtered refresh they are
 * the ONLY record of the work: the job row carries a person COUNT, not the
 * ids, and the filter they came from cannot be re-resolved honestly (it reads
 * `platform_pushes`, which the sync writes as it runs). Dropping them turned
 * a 25,000-person refresh that stopped at 9,000 into 16,000 people silently
 * lost, under an error message telling the user to re-run something no UI
 * offers.
 *
 * Returns whether a resume is now pending. */
async function markActivityJobForResume(job: PushJob, day: string): Promise<boolean> {
  const partition = privateQueuePartitionOf(job);
  if (!partition) return false;
  try {
    const remaining = await countActivityQueue(job.clientId, partition);
    if (remaining === 0) return false;
    await updateJobOptions(job.id, {
      ...job.options,
      [BUDGET_STOP_OPTION_KEY]: { day, queueJobId: partition } satisfies ActivityBudgetStopMarker,
    });
    return true;
  } catch (err) {
    // Best-effort: failing to WRITE the marker must not also fail the job
    // row's own write-back. The rows stay in place either way, so the worst
    // case is a remainder that needs a human to notice, not one that is gone.
    console.error(`[push-worker] could not mark job ${job.id} for budget resume: ${errorMessage(err)}`);
    return false;
  }
}

/** One kind of resume marker, as the shared resume loop needs to see it.
 *
 * Two markers exist and they are NOT the same thing — a budget stop is "come
 * back tomorrow, nothing is wrong", a failure retry is "something went wrong,
 * try a couple more times". They differ in pacing (a UTC day boundary vs. an
 * elapsed backoff), in whether attempts are bounded, and in what the job row
 * tells the user. What they genuinely share is the *mechanism* below: find the
 * marked jobs, atomically claim one, queue a continuation that ADOPTS the
 * partition instead of re-resolving anything, and put the marker back if that
 * fails. That part, and only that part, is unified here. */
interface ResumeMarkerSpec {
  /** `options` key the marker lives under. */
  optionKey: string;
  /** Marker field whose value makes the claim conditional — the budget stop's
   * `day`, the failure retry's `failedAt`. */
  claimField: string;
  /** For logs. */
  label: string;
  /** Reads the marker off a job and decides whether it is ready to run NOW.
   * Null means "not mine, or not yet" — the pacing rule for this marker kind
   * lives here. */
  read(job: PushJob): { queueJobId: string; claimValue: string; retryAttempt: number } | null;
}

/** Hands every ready remainder to a fresh job. Runs once per invocation, next
 * to the stale-job reaper, for the same reason: it is the only thing that will
 * ever pick that work back up.
 *
 * The continuation is a NEW job rather than the old one re-queued because
 * `claim_next_runnable_job` has no run-after predicate — see
 * ActivityQueuedScope. Its scope adopts the partition, so it resolves nothing,
 * sweeps nothing and simply drains what is there.
 *
 * Best-effort throughout: a missing table, a transient error or a lost race
 * with a concurrent invocation leaves the marker (or restores it) for the next
 * pass rather than aborting the tick loop. */
async function resumeMarkedActivityJobs(spec: ResumeMarkerSpec): Promise<number> {
  const marked = await listMarkedActivityJobs(spec.optionKey);
  let resumed = 0;

  for (const job of marked) {
    const ready = spec.read(job);
    if (!ready) continue;

    const remaining = await countActivityQueue(job.clientId, ready.queueJobId);
    const withoutMarker = { ...job.options };
    delete withoutMarker[spec.optionKey];
    // Claimed BEFORE the continuation is queued, and conditional on the marker
    // value still being the one we read: two overlapping invocations must not
    // both queue a continuation for one partition.
    if (
      !(await claimActivityJobMarker(
        job.id,
        { key: spec.optionKey, field: spec.claimField, value: ready.claimValue },
        withoutMarker
      ))
    ) {
      continue;
    }
    if (remaining === 0) continue; // drained by hand or by an earlier continuation

    try {
      const continuation = await enqueueGhlActivitySync({
        clientId: job.clientId,
        scope: { kind: "queued", personCount: remaining, queueJobId: ready.queueJobId },
        // Carried forward so a chain of continuations remembers how many
        // attempts it has burned. A budget stop spends none of them.
        retryAttempt: ready.retryAttempt,
        triggeredByUserId: job.triggeredByUserId,
        triggeredByEmail: job.triggeredByEmail,
      });
      resumed++;
      console.log(
        `[push-worker] resumed ${spec.label} job ${job.id} as ${continuation.id} ` +
          `(partition=${ready.queueJobId}, remaining=${remaining}, retryAttempt=${ready.retryAttempt})`
      );
    } catch (err) {
      console.error(`[push-worker] failed to resume ${spec.label} job ${job.id}: ${errorMessage(err)}`);
      // Put the marker back, or the remainder becomes invisible: the rows are
      // still there and nothing else looks for them.
      await updateJobOptions(job.id, job.options).catch((restoreErr) => {
        console.error(
          `[push-worker] job ${job.id} has ${remaining} undrained activity rows in partition ` +
            `${ready.queueJobId} and its resume marker could not be restored: ${errorMessage(restoreErr)}`
        );
      });
    }
  }
  return resumed;
}

/** Budget stops: paced by the UTC day rolling over, unbounded in attempts
 * (nothing is wrong, the location simply has no quota left today). */
function resumeBudgetStoppedActivityJobs(): Promise<number> {
  const today = budgetDay();
  return resumeMarkedActivityJobs({
    optionKey: BUDGET_STOP_OPTION_KEY,
    claimField: "day",
    label: "budget-stopped",
    read: (job) => {
      const marker = budgetStopMarkerFrom(job.options);
      if (!marker || !isResumableOn(marker, today)) return null;
      return {
        queueJobId: marker.queueJobId,
        claimValue: marker.day,
        // A budget stop is not a failure and must not consume a retry, but it
        // must not RESET one either: a chain that had already failed once and
        // then budget-stopped keeps its count.
        retryAttempt: retryAttemptsSpent(job.options),
      };
    },
  });
}

/** Failure retries: paced by ACTIVITY_RETRY_BACKOFF_MS of wall clock since the
 * failure, and hard-bounded at MAX_ACTIVITY_RETRY_ATTEMPTS.
 *
 * The pacing has to be wall clock because, unlike a budget stop, there is no
 * day rollover to wait for and `claim_next_runnable_job` (SQL, off-limits) has
 * no run-after predicate. This scan runs at the top of EVERY invocation —
 * self-chains and route kicks make that far more often than the one-a-minute
 * cron — so the backoff is what stops a failing partition from burning all its
 * attempts within seconds and hammering the GHL API. The attempt count, not
 * the clock, is what guarantees termination. */
function resumeFailedActivityJobs(): Promise<number> {
  const now = new Date();
  return resumeMarkedActivityJobs({
    optionKey: FAILURE_RETRY_OPTION_KEY,
    claimField: "failedAt",
    label: "failure-retry",
    read: (job) => {
      const marker = failureRetryMarkerFrom(job.options);
      if (!marker) return null;
      // Defence in depth: planActivityFailureRetry never writes a marker past
      // the limit, but a hand-edited or legacy blob must not resurrect a job
      // forever.
      if (marker.attempt > MAX_ACTIVITY_RETRY_ATTEMPTS) return null;
      if (!isRetryDueAt(marker, now)) return null;
      return { queueJobId: marker.queueJobId, claimValue: marker.failedAt, retryAttempt: marker.attempt };
    },
  });
}

function terminalStatus(succeeded: number, failed: number): Exclude<PushJobStatus, "queued" | "running"> {
  if (failed === 0) return "succeeded";
  if (succeeded === 0) return "failed";
  return "partial";
}

/** Runs one tick of `job`, persisting the outcome. Returns true once the job
 * has reached a terminal state (this tick finished it, or it hit an
 * unrecoverable condition), false when it's still `running` with an advanced
 * cursor and should be resumed on a later tick. */
async function processJobTick(job: PushJob, workerDeadline: number): Promise<boolean> {
  const client = await getClientById(job.clientId);
  if (!client) {
    await finishJob(job.id, {
      status: "failed",
      total: job.total,
      processed: job.processed,
      succeeded: job.succeeded,
      created: job.created,
      updated: job.updated,
      failed: job.failed,
      failures: job.failures,
      error: `Client ${job.clientId} not found`,
    });
    await discardPrivateQueuePartition(job);
    return true;
  }

  const offset = (job.cursor?.offset as number | undefined) ?? 0;
  const deadline = Math.min(workerDeadline, Date.now() + TICK_BUDGET_MS);
  const actor = { id: job.triggeredByUserId ?? "", email: job.triggeredByEmail ?? "" };

  const tick = await runTick(job, client, actor, offset, deadline);

  // Running totals are seeded from the job row and advanced by this tick's
  // delta, so a resumed job keeps accumulating rather than resetting.
  const succeeded = job.succeeded + tick.succeededPersonIds.length;
  const created = job.created + tick.created;
  const updated = job.updated + tick.updated;
  const failed = job.failed + tick.failedPersonIds.length;
  const failures = [...job.failures, ...tick.failures].slice(-MAX_FAILURES_KEPT);

  // Per-record tagging — safe to re-write across ticks thanks to the
  // (push_job_id, person_id)/(push_job_id, company_id) upsert keys.
  //
  // `job.entity` alone ("people"/"companies", the trigger surface) is NOT the
  // right signal here: a GHL push triggered from the Companies table still
  // resolves internally to linked People (CONTEXT.md's "Companies-table push"
  // glossary entry, unaffected by docs/adr/0005-company-native-emailbison-push.md)
  // — its tick.succeededPersonIds/failedPersonIds are real person ids even
  // though job.entity === "companies". Only a company-native EmailBison push
  // (job.platform === "emailbison_companies", or "emailbison_campaign" with
  // job.entity === "companies") actually returns company ids in those arrays.
  const tickIdsAreCompanyIds =
    job.platform === "emailbison_companies" ||
    (job.platform === "emailbison_campaign" && job.entity === "companies");
  await recordJobPeople(job.id, tickIdsAreCompanyIds ? "companies" : "people", [
    ...tick.succeededPersonIds.map((personId) => ({ personId, outcome: "succeeded" as const })),
    ...tick.failedPersonIds.map((personId) => ({ personId, outcome: "failed" as const })),
  ]);

  // A tick that stopped on a standing condition (the per-location daily GHL
  // API budget) ends THIS job, but not the work: the condition holds until the
  // UTC day rolls over, so self-chaining would spin the worker on a job that
  // cannot advance, while discarding its queue partition would destroy a work
  // list that for a filtered refresh exists nowhere else.
  //
  // So: the job row goes terminal and says what happened, the partition stays,
  // and a marker on `options` tells `resumeBudgetStoppedActivityJobs` to hand
  // the remainder to a fresh job once the budget resets. Status is `partial`
  // even with nothing succeeded — a stop on the very first reservation is
  // information ("no quota left today"), not a failure, and the work is still
  // queued. `failed` is reserved for work that will not happen on its own.
  if (tick.stoppedReason) {
    const resumable = await markActivityJobForResume(job, budgetDay());
    await finishJob(job.id, {
      // `partial` even when the very first reservation was refused and
      // nothing at all ran. "No quota left for this location today" is
      // information about the location, not a fault in this job, and a red
      // Failed row invites someone to go looking for a bug that isn't there.
      status: "partial",
      total: tick.total,
      processed: tick.nextOffset,
      succeeded,
      created,
      updated,
      failed,
      failures,
      error: resumable
        ? `${tick.stoppedReason} The remaining ${Math.max(tick.total - tick.nextOffset, 0)} contacts stay queued ` +
          `and resume automatically after 00:00 UTC.`
        : tick.stoppedReason,
    });
    if (!resumable) await discardPrivateQueuePartition(job);
    console.warn(`[push-worker] job ${job.id} stopped: ${tick.stoppedReason} (resumable=${resumable})`);
    return true;
  }

  if (tick.done) {
    await finishJob(job.id, {
      status: terminalStatus(succeeded, failed),
      // Persist total/processed here (feedback item 2a): a job that finishes in
      // one tick never calls updateJobProgress, so without this `total` stays 0
      // and the panel shows "Total selected: 0". processed = total once done.
      total: tick.total,
      processed: tick.total,
      succeeded,
      created,
      updated,
      failed,
      failures,
      error: null,
    });
    await logActivity(
      job.platform === "ghl_activity"
        ? "ghl.activity_sync"
        : job.platform === "ghl"
          ? "ghl.push"
          : "emailbison.push",
      {
        target: job.entity,
        action: job.action,
        clientId: job.clientId,
        jobId: job.id,
        total: tick.total,
        succeeded,
        created,
        updated,
        failed,
      },
      actor
    );

    // A push wrote fresh platform_contact_ids; queue the activity sync that
    // turns them into last-activity dates, so a user who pushes and then looks
    // at the column doesn't have to know a second button exists. Only for a
    // GHL push that actually landed at least one contact, and never for an
    // activity job itself (which would chain forever). Best-effort: the push
    // succeeded, so a failed enqueue is logged, not escalated — the manual
    // Refresh button and the next sync both recover it.
    if (job.platform === "ghl" && succeeded >= 1) {
      try {
        const syncJob = await enqueueGhlActivitySync({
          clientId: job.clientId,
          // Decision 5, layer 1 — the single biggest cost control in this
          // feature. A push of 100k genuinely-new leads used to auto-enqueue a
          // sync that made ~100k export calls (~3.5 hours, half the location's
          // daily quota) to discover 100k contacts GHL had created seconds
          // earlier and which therefore cannot have a conversation. With the
          // `new` flag now persisted as platform_pushes.was_deduped, that sync
          // skips them and costs ~0 extra calls.
          //
          // It narrows the COLD-contact fan-out only, not the sweep: a brand-
          // new contact that genuinely did get a reply still surfaces in the
          // conversation sweep (one or two pages either way) and is read. And
          // the predicate is "was_deduped IS NOT false", never "= true" —
          // every row pushed before the column existed is NULL, and treating
          // NULL as "brand new" would drop the entire existing corpus from
          // every post-push sync with no error at all.
          dedupedOnly: true,
          triggeredByUserId: job.triggeredByUserId,
          triggeredByEmail: job.triggeredByEmail,
        });
        console.log(
          `[push-worker] queued GHL activity sync ${syncJob.id} after push ${job.id} (client=${job.clientId})`
        );
      } catch (err) {
        console.error(
          `[push-worker] failed to queue GHL activity sync after push ${job.id}: ${errorMessage(err)}`
        );
      }
    }

    // Auto-launch the campaign now that leads are attached (moved off create
    // time, where a just-created campaign has zero leads and EmailBison 400s an
    // empty launch). Fires exactly once — only here on the terminal tick — and
    // only when ≥1 lead actually attached (`succeeded >= 1`), which guards both
    // the original empty-campaign 400 and the #106 partial/empty-drop case
    // (a 2xx attach that silently no-ops every lead). Best-effort: the leads
    // were attached successfully, so a failed auto-launch is logged but must
    // NOT mark the job failed.
    if (
      job.platform === "emailbison_campaign" &&
      job.campaignId &&
      job.options?.launchOnComplete === true &&
      succeeded >= 1
    ) {
      if (client.emailbisonApiKey && client.emailbisonWorkspaceId) {
        const credentials = {
          apiKey: client.emailbisonApiKey,
          workspaceId: client.emailbisonWorkspaceId,
        };
        try {
          await resumeCampaign(credentials, job.campaignId);
          console.log(
            `[push-worker] auto-launched EmailBison campaign ${job.campaignId} (jobId=${job.id}, succeeded=${succeeded})`
          );
          await logActivity(
            "emailbison.campaign.launch",
            { clientId: job.clientId, jobId: job.id, campaignId: job.campaignId, succeeded },
            actor
          );
        } catch (err) {
          const message = errorMessage(err);
          console.error(
            `[push-worker] auto-launch failed for campaign ${job.campaignId} (jobId=${job.id}): ${message}`
          );
        }
      } else {
        console.error(
          `[push-worker] cannot auto-launch campaign ${job.campaignId} (jobId=${job.id}): client has no EmailBison credentials`
        );
      }
    }

    return true;
  }

  await updateJobProgress(job.id, {
    total: tick.total,
    processed: tick.nextOffset,
    succeeded,
    created,
    updated,
    failed,
    failures,
    cursor: { offset: tick.nextOffset },
  });
  return false;
}

/** Reads the `{ jobId }` the self-chain POSTs so a not-yet-done job resumes on
 * the exact same row rather than being re-claimed. Cron GETs and the enqueue-
 * route kicks carry no body — those start on the claim path (pick up whatever
 * is runnable). Malformed/absent bodies fall through to null. */
async function resumeJobIdFrom(request: Request): Promise<string | null> {
  if (request.method !== "POST") return null;
  try {
    const body = (await request.json()) as { jobId?: unknown } | null;
    return body && typeof body.jobId === "string" ? body.jobId : null;
  } catch {
    return null;
  }
}

/** The shared tick loop behind both GET (Vercel Cron) and POST (self-chain /
 * route-triggered kick). Processes jobs until nothing is runnable or the wall-
 * clock budget is spent; self-chains via `after()` when it stops with work
 * still outstanding, so a large push spans multiple invocations without
 * waiting for the next cron minute.
 *
 * Two entry paths, so per-client concurrency (#121) works: a self-chain POSTs
 * the in-progress `jobId` and resumes *that* row directly (its client stays
 * `running`, so a concurrent invocation's claim skips it and can pick up a
 * *different* client's job instead — the two run in parallel). Everything else
 * claims the next runnable job — the oldest `queued` job whose client isn't
 * already running — so a second push to the same client waits its turn. */
async function runWorker(request: Request): Promise<Response> {
  const workerDeadline = Date.now() + WORKER_BUDGET_MS;
  let processed = 0;
  let chained = false;

  // Reaper: reclaim jobs stranded in `running` by a crashed/hard-killed
  // invocation (#137) before doing anything else. Such a row otherwise blocks
  // its client's queue forever (the per-client claim predicate excludes a
  // client that has any `running` job) and, in bulk, exhausts the global
  // MAX_CONCURRENT_JOBS cap for every client. Running on every invocation
  // (self-chain, kick, or the cron backstop) means recovery lands within ~one
  // cron minute of the lease lapsing. Best-effort: a missing function (SQL not
  // yet applied to the DB) or a transient DB error must not abort the tick
  // loop, so failures are logged and swallowed.
  try {
    const reaped = await resetStaleRunningJobs();
    if (reaped > 0) {
      console.warn(`[push-worker] reaped ${reaped} stale running job(s) back to queued`);
    }
  } catch (err) {
    const message = errorMessage(err);
    console.error(`[push-worker] stale-job reaper failed: ${message}`);
  }

  // Budget resume: the counterpart to the reaper. A job the per-location daily
  // GHL budget stopped left its undrained queue partition behind on purpose;
  // once the UTC day has rolled over, that remainder gets a fresh job. Same
  // best-effort contract as the reaper — a failure here must not cost the
  // invocation the jobs it could otherwise run.
  try {
    await resumeBudgetStoppedActivityJobs();
  } catch (err) {
    console.error(`[push-worker] budget-stop resume failed: ${errorMessage(err)}`);
  }

  // Failure retry: the same adoption mechanism, different question. A job that
  // threw unexpectedly (a connection-pool timeout, say) left its undrained
  // partition behind with a bounded, backed-off retry marker; this hands it to
  // a fresh job once the backoff has elapsed, and gives up — loudly, on the
  // job row — once the attempts are spent. Same best-effort contract.
  try {
    await resumeFailedActivityJobs();
  } catch (err) {
    console.error(`[push-worker] failure-retry resume failed: ${errorMessage(err)}`);
  }

  const scheduleSelfChain = (jobId?: string) => {
    chained = true;
    after(() => {
      fetch(new URL(WORKER_PATH, request.url), {
        method: "POST",
        headers: jobId
          ? { ...selfChainHeaders(), "content-type": "application/json" }
          : selfChainHeaders(),
        body: jobId ? JSON.stringify({ jobId }) : undefined,
      }).catch((err) => {
        const message = errorMessage(err);
        console.error(
          `[push-worker] self-chain kick failed${jobId ? ` (jobId=${jobId})` : ""}: ${message}`
        );
      });
    });
  };

  // First iteration resumes the self-chained job (if any); later iterations
  // always claim, so one invocation still drains several independent jobs.
  let resumeJobId = await resumeJobIdFrom(request);

  while (true) {
    if (Date.now() >= workerDeadline) {
      // Out of time between jobs — hand off so remaining queued work continues.
      scheduleSelfChain();
      break;
    }

    // Acquiring the next job (resume-lookup or claim RPC) can throw — a missing
    // RPC surfaces as PGRST202, a dropped connection as a network error. This
    // used to run outside any try/catch, so a throw here killed the whole
    // invocation with a 500 and left jobs stuck at Queued with no signal (#136).
    // Log it with context and stop this invocation cleanly instead; the next
    // cron tick retries.
    const wasResume = Boolean(resumeJobId);
    let job: PushJob | null;
    try {
      if (resumeJobId) {
        // A running job may already be terminal (e.g. its client vanished and a
        // prior tick failed it) — only resume if it's still running, else fall
        // through to the claim path on the next loop.
        const resumed = await getPushJob(resumeJobId);
        job = resumed && resumed.status === "running" ? resumed : null;
      } else {
        job = await claimNextRunnableJob(MAX_CONCURRENT_JOBS);
      }
    } catch (err) {
      const message = errorMessage(err);
      console.error(
        `[push-worker] failed to acquire next job${
          resumeJobId ? ` (resume jobId=${resumeJobId})` : " (claim)"
        }: ${message}`
      );
      break;
    }
    resumeJobId = null;
    if (wasResume) {
      if (!job) continue; // resumed job already terminal — claim on the next loop
    } else if (!job) {
      break; // nothing runnable (queue drained or all clients busy)
    }

    processed++;
    let finished: boolean;
    try {
      finished = await processJobTick(job, workerDeadline);
    } catch (err) {
      const message = errorMessage(err);
      // An activity job whose remainder exists nowhere but its queue partition
      // gets a bounded, paced retry rather than having that remainder deleted
      // by one transient throw. Everything else (and an exhausted chain) ends
      // exactly as it did — but the row now SAYS the remainder was dropped,
      // and how much of it, instead of reporting a failure that quietly lost
      // most of the work.
      const plan = await planFailureForActivityJob(job, message);
      await finishJob(job.id, {
        status: "failed",
        total: job.total,
        processed: job.processed,
        succeeded: job.succeeded,
        created: job.created,
        updated: job.updated,
        failed: job.failed,
        failures: job.failures,
        error: plan.error,
      });
      // Either the partition is adopted by a retry or it is discarded here.
      // Never neither: rows nothing will come back for are a leak.
      if (!plan.retryPending) await discardPrivateQueuePartition(job);
      finished = true; // terminal — don't strand the whole invocation on one bad job
    }

    if (!finished) {
      // Tick hit its deadline mid-job — resume this exact job next invocation.
      scheduleSelfChain(job.id);
      break;
    }
  }

  return Response.json({ ok: true, processed, chained });
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return runWorker(request);
}

export async function POST(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  return runWorker(request);
}
