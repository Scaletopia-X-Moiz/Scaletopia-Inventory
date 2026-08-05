import { after } from "next/server";
import {
  getResumableJob,
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

const WORKER_PATH = "/api/internal/push-worker";

/** Optional shared-secret gate. Security is explicitly not the priority for
 * this internal team tool (epic #118) — if neither secret env var is set the
 * check is skipped entirely (dev-friendly). CRON_SECRET matches Vercel Cron's
 * automatic `Authorization: Bearer` header; PUSH_WORKER_SECRET matches the
 * `x-worker-secret` header on our own self-chain / route-triggered kicks. */
function authorized(request: Request): boolean {
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
      succeededPersonIds: result.succeededPersonIds,
      failedPersonIds: result.failedPersonIds,
      // GhlPushResult only carries failed display names (reasons go to server
      // logs), so the reason is generic here — richer per-failure detail is
      // deferred to #122.
      failures: result.failed_people.map((name) => ({ name, reason: "GHL push failed — see server logs" })),
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
      succeeded: job.succeeded,
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
      succeeded,
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
    failed,
    cursor: { offset: tick.nextOffset },
  });
  return false;
}

/** The shared tick loop behind both GET (Vercel Cron) and POST (self-chain /
 * route-triggered kick). Processes jobs until the queue drains or the wall-
 * clock budget is spent; self-chains via `after()` when it stops with work
 * still outstanding, so a large push spans multiple invocations without
 * waiting for the next cron minute. */
async function runWorker(request: Request): Promise<Response> {
  const workerDeadline = Date.now() + WORKER_BUDGET_MS;
  let processed = 0;
  let chained = false;

  const scheduleSelfChain = () => {
    chained = true;
    after(() => {
      fetch(new URL(WORKER_PATH, request.url), {
        method: "POST",
        headers: selfChainHeaders(),
      }).catch(() => {});
    });
  };

  while (true) {
    if (Date.now() >= workerDeadline) {
      // Out of time — a running/queued job may still remain; hand off.
      scheduleSelfChain();
      break;
    }

    const job = await getResumableJob();
    if (!job) break; // queue drained

    processed++;
    let finished: boolean;
    try {
      finished = await processJobTick(job, workerDeadline);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await finishJob(job.id, {
        status: "failed",
        succeeded: job.succeeded,
        failed: job.failed,
        failures: job.failures,
        error: message,
      });
      finished = true; // terminal — don't strand the whole invocation on one bad job
    }

    if (!finished) {
      // Tick hit its deadline mid-job — resume on the next invocation.
      scheduleSelfChain();
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
