import { after } from "next/server";
import {
  claimNextRunnableJob,
  resetStaleRunningJobs,
  getPushJob,
  updateJobProgress,
  finishJob,
  recordJobPeople,
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
import { runPeopleGhlPush } from "@/lib/ghl/push-to-ghl";
import type { PersonListFilters } from "@/lib/data/people";
import type { CompanyListFilters } from "@/lib/data/companies";
import type { EmailBisonCustomVariableEntry, EmailBisonStandardFieldMapping } from "@/lib/emailbison/types";
import type { GhlFieldMapping, GhlStandardFieldMapping } from "@/lib/ghl/types";

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
 * The Push Activity panel (#122) surfaces only a sample of failures anyway. */
const MAX_FAILURES_KEPT = 50;

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

  if (job.platform === "ghl") {
    const result = await runPeopleGhlPush(job.filters as unknown as PersonListFilters, client, actor, {
      offset,
      deadline,
      fieldMapping: options.fieldMapping as GhlFieldMapping[] | undefined,
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

  if (job.platform === "emailbison_people" || job.platform === "emailbison_companies") {
    const deps = {
      offset,
      deadline,
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
  // (push_job_id, person_id) upsert key.
  await recordJobPeople(job.id, [
    ...tick.succeededPersonIds.map((personId) => ({ personId, outcome: "succeeded" as const })),
    ...tick.failedPersonIds.map((personId) => ({ personId, outcome: "failed" as const })),
  ]);

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
      job.platform === "ghl" ? "ghl.push" : "emailbison.push",
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
    return true;
  }

  await updateJobProgress(job.id, {
    total: tick.total,
    processed: tick.nextOffset,
    succeeded,
    created,
    updated,
    failed,
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
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[push-worker] stale-job reaper failed: ${message}`);
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
        const message = err instanceof Error ? err.message : String(err);
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
      const message = err instanceof Error ? err.message : String(err);
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
      const message = err instanceof Error ? err.message : String(err);
      await finishJob(job.id, {
        status: "failed",
        total: job.total,
        processed: job.processed,
        succeeded: job.succeeded,
        created: job.created,
        updated: job.updated,
        failed: job.failed,
        failures: job.failures,
        error: message,
      });
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
