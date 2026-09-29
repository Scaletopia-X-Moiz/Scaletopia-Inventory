import { after } from "next/server";
import {
  claimNextImportJob,
  resetStaleImportJobs,
  getImportJob,
  updateImportJobProgress,
  touchImportJobLease,
  finishImportJob,
  advanceImportJobStage,
  type ImportJob,
  type ImportJobStatus,
  type ImportStageResult,
} from "@/lib/data/import-jobs";
import { runImportTick, type ImportTickResult } from "@/lib/import/push";
import { parseCSV, applyColumnMap } from "@/lib/import/csv";
import { IMPORT_BUCKET } from "@/lib/import/storage";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { logActivity } from "@/lib/activity/log";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/** Overall wall-clock budget for one worker invocation. Kept safely under the
 * 300s serverless cap so the progress/finish write-backs, plus the self-chain
 * `after` fetch, always have headroom before the platform kills the
 * invocation. Same figures as the push worker. */
const WORKER_BUDGET_MS = 270_000;
/** Deadline handed to a single runImportTick — it stops after the chunk in
 * flight once this passes, returning the offset to resume from. Capped by the
 * worker budget so a tick never runs past the invocation's own deadline. */
const TICK_BUDGET_MS = 210_000;
/** Conservative floor for one chunk's duration. A new chunk only starts when
 * this (or 1.5x the slowest chunk so far) still fits before the tick deadline,
 * leaving headroom for the DB's 120s statement timeout on a bad chunk. */
const MIN_CHUNK_MS = 60_000;
/** Lease heartbeat cadence. Runs on a timer for the WHOLE tick (CSV download,
 * parse, key fetch, slow RPCs), not just between chunks. */
const HEARTBEAT_MS = 30_000;
/** Before moving on to the next stage in the same invocation, at least this
 * much budget must remain: stage 2 first fetches every people key plus the
 * whole companies table. Otherwise hand off to a fresh invocation. */
const STAGE_START_MIN_MS = 120_000;
/** Cap on the failed records persisted on the job row / copied into
 * import_history for one stage. `import_history.failed_records` used to be
 * uncapped; this bounds the jsonb growth across ticks of a failure-heavy run.
 * When the cap is hit a truncation marker is appended (see
 * appendFailedRecords) and `failed` still carries the true count. */
const MAX_FAILED_RECORDS_KEPT = 5000;

const WORKER_PATH = "/api/internal/import-worker";

/** Optional shared-secret gate — same rules as the push worker (this route
 * deliberately reuses PUSH_WORKER_SECRET / CRON_SECRET, there is no new
 * secret). If neither env var is set the check is skipped (dev-friendly);
 * genuine Vercel cron invocations are trusted directly. */
function authorized(request: Request): boolean {
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

/** Header set on our own worker->worker self-chain fetch, so a configured
 * PUSH_WORKER_SECRET still lets the chained invocation through. */
function selfChainHeaders(): Record<string, string> {
  const workerSecret = process.env.PUSH_WORKER_SECRET;
  return workerSecret ? { "x-worker-secret": workerSecret } : {};
}

/** Serializes a thrown value to a human-diagnosable string. An `Error` yields
 * its message; a non-Error object (e.g. the bare {message} shape supabase-js
 * returns) is JSON-stringified rather than String()'d, which would collapse to
 * the useless "[object Object]". */
function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;

  try {
    const json = JSON.stringify(err);
    if (json && json !== "{}" && json !== "null") return json;
  } catch {
    // circular / non-serializable — fall through to the field/String path
  }

  if (err && typeof err === "object") {
    const rec = err as Record<string, unknown>;
    for (const key of ["message", "code", "error_description", "error", "details"]) {
      const val = rec[key];
      if (typeof val === "string" && val.length > 0) return `${key}: ${val}`;
    }
  }

  const str = String(err);
  if (str === "[object Object]") return `non-Error thrown: ${Object.prototype.toString.call(err)}`;
  return str;
}

/** Outcome of one tick of a job.
 *  - finished: terminal state written (job done or failed for good).
 *  - continue: job still `running` with an advanced cursor; self-chain.
 *  - lost:     a write matched zero rows, i.e. the job is no longer `running`
 *              under this worker (reaped/finished elsewhere). Stop quietly and
 *              do NOT chain or touch the CSV; the new owner has it.
 *  - retry:    a bookkeeping write or storage read failed transiently. The job
 *              is left `running` and its CSV kept; the reaper re-queues it once
 *              its lease goes stale and it resumes from the last saved cursor. */
type TickOutcome = "finished" | "continue" | "lost" | "retry";

class LeaseLostError extends Error {
  constructor() {
    super("import job is no longer running under this worker");
  }
}

/** A failure of bookkeeping (progress/advance/finish write, storage read), as
 * opposed to a failure of the import itself. Never fails the job. */
class RetryableError extends Error {}

/** Runs a bookkeeping write. A transient error becomes a RetryableError; a
 * write that matched no running row (`false`) becomes a LeaseLostError. */
async function bookkeep(write: () => Promise<boolean>): Promise<void> {
  let applied: boolean;
  try {
    applied = await write();
  } catch (err) {
    throw new RetryableError(errorMessage(err));
  }
  if (!applied) throw new LeaseLostError();
}

/** Only a definite "object not found" means the CSV is gone for good. */
function isStorageNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as Record<string, unknown>;
  const status = String(rec.statusCode ?? rec.status ?? "");
  const message = typeof rec.message === "string" ? rec.message : "";
  return status === "404" || /not.?found/i.test(message);
}

function terminalStatus(succeeded: number, failed: number): Exclude<ImportJobStatus, "queued" | "running"> {
  if (failed === 0) return "succeeded";
  if (succeeded === 0) return "failed";
  return "partial";
}

/** Appends `incoming` failed records to `existing`, keeping at most
 * MAX_FAILED_RECORDS_KEPT real records. Once the cap is hit a single
 * `_truncated` marker record is kept at the end (and re-stripped/re-added on
 * later calls so it never counts against the cap or duplicates). */
function appendFailedRecords(
  existing: Record<string, unknown>[],
  incoming: Record<string, unknown>[]
): Record<string, unknown>[] {
  const real = existing.filter((r) => !r._truncated);
  const wasTruncated = real.length !== existing.length;
  const room = Math.max(0, MAX_FAILED_RECORDS_KEPT - real.length);
  const kept = [...real, ...incoming.slice(0, room)];
  const truncated = wasTruncated || incoming.length > room;
  if (!truncated) return kept;
  return [
    ...kept,
    {
      _truncated: true,
      _note: `Only the first ${MAX_FAILED_RECORDS_KEPT.toLocaleString("en-US")} failed records are kept; see the failed count for the true total.`,
    },
  ];
}

/** Best-effort removal of the job's CSV. Only ever called once the job is
 * terminal — never per tick, since every tick re-reads the file. */
async function removeJobFile(job: ImportJob): Promise<void> {
  try {
    await supabaseAdmin.storage.from(IMPORT_BUCKET).remove([job.storagePath]);
  } catch {
    // Best-effort cleanup; an orphaned temp object isn't fatal.
  }
}

/** Writes the one `import_history` row for a stage and returns its id (null if
 * the insert fails — history is a record of the run, so it never fails the
 * job). Same column set pushRecords writes, plus `import_job_id`, with
 * `started_at` = the job's start rather than the column default. */
async function insertStageHistory(
  job: ImportJob,
  stage: {
    targetTable: "companies" | "people";
    inputCount: number;
    dedupedCount: number;
    inserted: number;
    updated: number;
    failedCount: number;
    failedRecords: Record<string, unknown>[];
  }
): Promise<string | null> {
  // Guard against a double row: if a previous attempt wrote this stage's
  // history but crashed before advancing the cursor, reuse that row instead of
  // inserting a second one. Best-effort; a failed lookup falls through to insert.
  try {
    const { data: existing } = await supabaseAdmin
      .from("import_history")
      .select("id")
      .eq("import_job_id", job.id)
      .eq("target_table", stage.targetTable)
      .limit(1);
    const existingId = (existing as { id: string }[] | null)?.[0]?.id;
    if (existingId) return existingId;
  } catch {
    // ignore — insert below
  }
  try {
    const { data } = await supabaseAdmin
      .from("import_history")
      .insert({
        source_key: job.sourceKey,
        target_table: stage.targetTable,
        tags: job.tags,
        input_count: stage.inputCount,
        deduped_count: stage.dedupedCount,
        inserted_count: stage.inserted,
        updated_count: stage.updated,
        failed_count: stage.failedCount,
        failed_records: stage.failedRecords,
        started_at: job.createdAt,
        completed_at: new Date().toISOString(),
        import_job_id: job.id,
      })
      .select("id")
      .single();
    return data?.id ?? null;
  } catch {
    return null;
  }
}

/** Runs one tick of `job` (and, for a two-stage job, carries straight on into
 * the next stage while budget remains), persisting the outcome.
 *
 * A `setInterval` renews the job's lease for the WHOLE tick (CSV download,
 * parse, key fetch, chunks), so a live worker is never reaped. Every write-back
 * is conditional on the job still being `running`; a write that matches no row
 * ends the tick quietly with "lost".
 *
 * The CSV is re-downloaded, re-parsed and re-deduped every tick (deterministic
 * and order-preserving), then sliced from the saved offset — see
 * docs/adr/0006-import-job-queue.md. */
async function processImportJobTick(job: ImportJob, workerDeadline: number): Promise<TickOutcome> {
  const lease = { lost: false };
  let heartbeatInFlight = false;
  const timer = setInterval(() => {
    if (heartbeatInFlight || lease.lost) return;
    heartbeatInFlight = true;
    touchImportJobLease(job.id)
      .then((ok) => {
        if (!ok) lease.lost = true;
      })
      .catch((err) => {
        console.error(`[import-worker] lease heartbeat failed (jobId=${job.id}): ${errorMessage(err)}`);
      })
      .finally(() => {
        heartbeatInFlight = false;
      });
  }, HEARTBEAT_MS);
  try {
    return await runJobTick(job, workerDeadline, lease);
  } finally {
    clearInterval(timer);
  }
}

async function runJobTick(
  job: ImportJob,
  workerDeadline: number,
  lease: { lost: boolean }
): Promise<TickOutcome> {
  const actor = { id: job.triggeredByUserId ?? "", email: job.triggeredByEmail ?? "" };

  const { data: file, error: downloadError } = await supabaseAdmin.storage
    .from(IMPORT_BUCKET)
    .download(job.storagePath);
  if (downloadError || !file) {
    // Only a definite not-found fails the job. A storage 5xx / network blip is
    // retryable: leave the job running so the reaper resumes it.
    if (!downloadError || !isStorageNotFound(downloadError)) {
      console.error(
        `[import-worker] CSV download failed, will retry (jobId=${job.id}): ${
          downloadError ? errorMessage(downloadError) : "no data returned"
        }`
      );
      return "retry";
    }
    try {
      const applied = await finishImportJob(job.id, {
        status: "failed",
        stageResults: job.stageResults,
        total: job.total,
        processed: job.processed,
        inserted: job.inserted,
        updated: job.updated,
        failed: job.failed,
        failedRecords: job.failedRecords,
        error: `Uploaded CSV is missing from storage (${job.storagePath}): ${errorMessage(downloadError)}`,
      });
      return applied ? "finished" : "lost";
    } catch (err) {
      console.error(`[import-worker] could not mark job failed (jobId=${job.id}): ${errorMessage(err)}`);
      return "retry";
    }
  }
  const { rows } = parseCSV(await file.text());

  // Running state of the CURRENT stage, seeded from the job row and advanced by
  // each tick's delta, so a resumed job keeps accumulating rather than
  // resetting. Reset when the stage advances.
  let stageIdx = job.cursor?.stage ?? 0;
  let offset = job.cursor?.offset ?? 0;
  let inserted = job.inserted;
  let updated = job.updated;
  let failed = job.failed;
  let failedRecords = job.failedRecords;
  let stageResults = job.stageResults;

  // Populated once a stage's records are mapped; the catch below needs it to
  // write a BUG-E style partial history row.
  let stageInputCount: number | null = null;
  const partial: ImportTickResult = {
    dedupedCount: 0,
    nextOffset: 0,
    done: false,
    inserted: 0,
    updated: 0,
    failedRecords: [],
  };

  try {
    while (true) {
      const stage = job.stages[stageIdx];
      if (!stage) throw new Error(`Import job ${job.id} has no stage ${stageIdx}`);

      // BUG D: the target is passed so people rows with only a company_name
      // (no personal identity) are dropped, same as the legacy stream route.
      const mapped = applyColumnMap(rows, stage.columnMap, stage.targetTable);
      stageInputCount = mapped.length;

      partial.dedupedCount = 0;
      partial.nextOffset = 0;
      partial.inserted = 0;
      partial.updated = 0;
      partial.failedRecords = [];

      const deadline = Math.min(workerDeadline, Date.now() + TICK_BUDGET_MS);
      const tick = await runImportTick({
        records: mapped,
        targetTable: stage.targetTable,
        sourceKey: job.sourceKey,
        tags: job.tags as [string, string, string],
        offset,
        deadline,
        minChunkMs: MIN_CHUNK_MS,
        partial,
        shouldStop: () => lease.lost,
        // Cursor + counts reach the DB after every chunk (and once right after
        // dedupe, so `total` is set early). `inserted`/`updated`/... are the
        // totals before this tick; `s` holds this tick's cumulative deltas.
        onCheckpoint: (s) =>
          bookkeep(() =>
            updateImportJobProgress(job.id, {
              total: s.dedupedCount,
              processed: s.nextOffset,
              inserted: inserted + s.inserted,
              updated: updated + s.updated,
              failed: failed + s.failedRecords.length,
              failedRecords: appendFailedRecords(failedRecords, s.failedRecords),
              cursor: { stage: stageIdx, offset: s.nextOffset },
            })
          ),
      });

      if (lease.lost) return "lost";

      // Fold this tick into the running totals, then reset the live sink so a
      // later throw in bookkeeping/catch can't count this tick a second time.
      inserted += tick.inserted;
      updated += tick.updated;
      failed += tick.failedRecords.length;
      failedRecords = appendFailedRecords(failedRecords, tick.failedRecords);
      partial.inserted = 0;
      partial.updated = 0;
      partial.failedRecords = [];

      if (!tick.done) {
        await bookkeep(() =>
          updateImportJobProgress(job.id, {
            total: tick.dedupedCount,
            processed: tick.nextOffset,
            inserted,
            updated,
            failed,
            failedRecords,
            cursor: { stage: stageIdx, offset: tick.nextOffset },
          })
        );
        return "continue";
      }

      // Stage finished: exactly one import_history row per stage.
      const historyId = await insertStageHistory(job, {
        targetTable: stage.targetTable,
        inputCount: mapped.length,
        dedupedCount: tick.dedupedCount,
        inserted,
        updated,
        failedCount: failed,
        failedRecords,
      });
      const stageResult: ImportStageResult = {
        targetTable: stage.targetTable,
        inputCount: mapped.length,
        dedupedCount: tick.dedupedCount,
        inserted,
        updated,
        failed,
        historyId,
      };
      stageResults = [...stageResults, stageResult];
      // History for this stage is written; a later throw must not add a second
      // (partial) row for it.
      stageInputCount = null;

      const stageActivity = {
        targetTable: stage.targetTable,
        sourceKey: job.sourceKey,
        tags: job.tags,
        inputCount: stageResult.inputCount,
        insertedCount: stageResult.inserted,
        updatedCount: stageResult.updated,
        failedCount: stageResult.failed,
        jobId: job.id,
        stage: stageIdx + 1,
        stageCount: job.stages.length,
      };

      if (stageIdx + 1 < job.stages.length) {
        await bookkeep(() => advanceImportJobStage(job.id, { stageResults, nextStage: stageIdx + 1 }));
        await logActivity("import.run", stageActivity, actor);
        stageIdx += 1;
        offset = 0;
        inserted = 0;
        updated = 0;
        failed = 0;
        failedRecords = [];
        // Not enough budget left for the next stage's key fetch + first chunk:
        // hand off and resume at stage N+1 in a fresh invocation.
        if (workerDeadline - Date.now() < STAGE_START_MIN_MS) return "continue";
        continue;
      }

      const totalSucceeded = stageResults.reduce((n, r) => n + r.inserted + r.updated, 0);
      const totalFailed = stageResults.reduce((n, r) => n + r.failed, 0);
      await bookkeep(() =>
        finishImportJob(job.id, {
          status: terminalStatus(totalSucceeded, totalFailed),
          stageResults,
          total: tick.dedupedCount,
          processed: tick.dedupedCount,
          inserted,
          updated,
          failed,
          failedRecords,
          error: null,
        })
      );
      await logActivity("import.run", stageActivity, actor);
      // Only after the terminal write succeeded.
      await removeJobFile(job);
      return "finished";
    }
  } catch (err) {
    // The job isn't ours any more, or a bookkeeping write failed: the import
    // itself did not fail. Leave the row and the CSV alone; a lost lease means
    // the new owner has both, a retryable one is resumed by the reaper.
    if (err instanceof LeaseLostError || lease.lost) return "lost";
    if (err instanceof RetryableError) {
      console.error(`[import-worker] bookkeeping failed, leaving job running (jobId=${job.id}): ${err.message}`);
      return "retry";
    }

    const message = errorMessage(err);

    // BUG E, carried over: if the current stage got far enough to have mapped
    // records, record whatever already landed as a partial history row (the
    // error rides along as a synthetic failed_records entry, since
    // import_history has no status/error column). `partial` was reset when the
    // last tick was folded into the totals, so nothing is counted twice.
    const stage = job.stages[stageIdx];
    if (stage && stageInputCount !== null) {
      const partialInserted = inserted + partial.inserted;
      const partialUpdated = updated + partial.updated;
      const partialFailed = appendFailedRecords(
        appendFailedRecords(failedRecords, partial.failedRecords),
        [{ _import_error: message, _partial: true }]
      );
      const partialFailedCount = failed + partial.failedRecords.length + 1;
      const historyId = await insertStageHistory(job, {
        targetTable: stage.targetTable,
        inputCount: stageInputCount,
        dedupedCount: partial.dedupedCount,
        inserted: partialInserted,
        updated: partialUpdated,
        failedCount: partialFailedCount,
        failedRecords: partialFailed,
      });
      stageResults = [
        ...stageResults,
        {
          targetTable: stage.targetTable,
          inputCount: stageInputCount,
          dedupedCount: partial.dedupedCount,
          inserted: partialInserted,
          updated: partialUpdated,
          failed: partialFailedCount,
          historyId,
        },
      ];
      inserted = partialInserted;
      updated = partialUpdated;
      failed = partialFailedCount;
      failedRecords = partialFailed;
    }

    let applied: boolean;
    try {
      applied = await finishImportJob(job.id, {
        status: "failed",
        stageResults,
        inserted,
        updated,
        failed,
        failedRecords,
        error: message,
      });
    } catch (finishErr) {
      // Could not record the failure: the row is still `running`, so keep the
      // CSV and let the reaper resume it.
      console.error(`[import-worker] could not mark job failed (jobId=${job.id}): ${errorMessage(finishErr)}`);
      return "retry";
    }
    if (!applied) return "lost";
    await logActivity(
      "import.run",
      {
        targetTable: stage?.targetTable,
        sourceKey: job.sourceKey,
        tags: job.tags,
        insertedCount: inserted,
        updatedCount: updated,
        failedCount: failed,
        error: message,
        failed: true,
        jobId: job.id,
      },
      actor
    );
    await removeJobFile(job);
    return "finished";
  }
}

/** Reads the `{ jobId }` the self-chain POSTs so a not-yet-done job resumes on
 * the exact same row rather than being re-claimed. Cron GETs and the enqueue-
 * route kicks carry no body and start on the claim path. */
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
 * route-triggered kick). Processes import jobs until nothing is runnable or
 * the wall-clock budget is spent; self-chains via `after()` when it stops with
 * work still outstanding, so a large import spans multiple invocations.
 *
 * Unlike the push worker there is no per-client or capped concurrency: the
 * claim function itself only hands out a job when no import job is `running`,
 * so imports run strictly one at a time (docs/adr/0006-import-job-queue.md). A
 * self-chain resumes its own `running` row by id, which is why it doesn't go
 * through the claim. */
async function runWorker(request: Request): Promise<Response> {
  const workerDeadline = Date.now() + WORKER_BUDGET_MS;
  let processed = 0;
  let chained = false;

  // Reaper: reclaim a job stranded in `running` by a crashed/hard-killed
  // invocation before doing anything else — such a row would otherwise hold
  // the global mutex forever and block every queued import. Best-effort: a
  // missing function (SQL not yet applied) or a transient DB error must not
  // abort the tick loop, so failures are logged and swallowed.
  try {
    const reaped = await resetStaleImportJobs();
    if (reaped > 0) {
      console.warn(`[import-worker] reaped ${reaped} stale running job(s) back to queued`);
    }
  } catch (err) {
    console.error(`[import-worker] stale-job reaper failed: ${errorMessage(err)}`);
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
        console.error(
          `[import-worker] self-chain kick failed${jobId ? ` (jobId=${jobId})` : ""}: ${errorMessage(err)}`
        );
      });
    });
  };

  // First iteration resumes the self-chained job (if any); later iterations
  // always claim, so one invocation still drains several queued jobs.
  let resumeJobId = await resumeJobIdFrom(request);

  while (true) {
    if (Date.now() >= workerDeadline) {
      // Out of time between jobs — hand off so remaining queued work continues.
      scheduleSelfChain();
      break;
    }

    // Acquiring the next job (resume-lookup or claim RPC) can throw — a missing
    // RPC surfaces as PGRST202, a dropped connection as a network error. Log it
    // and stop this invocation cleanly; the next cron tick retries.
    const wasResume = Boolean(resumeJobId);
    let job: ImportJob | null;
    try {
      if (resumeJobId) {
        // Only resume if the job is still running; a terminal one falls through
        // to the claim path on the next loop.
        const resumed = await getImportJob(resumeJobId);
        job = resumed && resumed.status === "running" ? resumed : null;
      } else {
        job = await claimNextImportJob();
      }
    } catch (err) {
      console.error(
        `[import-worker] failed to acquire next job${
          resumeJobId ? ` (resume jobId=${resumeJobId})` : " (claim)"
        }: ${errorMessage(err)}`
      );
      break;
    }
    resumeJobId = null;
    if (wasResume) {
      if (!job) continue; // resumed job already terminal — claim on the next loop
    } else if (!job) {
      break; // nothing runnable (queue drained, or an import is already running)
    }

    processed++;
    let outcome: TickOutcome;
    try {
      outcome = await processImportJobTick(job, workerDeadline);
    } catch (err) {
      // processImportJobTick handles its own failures; this catches anything
      // thrown outside that (e.g. an unparseable CSV). Fail the job, and delete
      // its CSV only if that terminal write actually landed.
      try {
        const applied = await finishImportJob(job.id, {
          status: "failed",
          stageResults: job.stageResults,
          total: job.total,
          processed: job.processed,
          inserted: job.inserted,
          updated: job.updated,
          failed: job.failed,
          error: errorMessage(err),
        });
        if (applied) await removeJobFile(job);
        outcome = applied ? "finished" : "lost";
      } catch (finishErr) {
        console.error(`[import-worker] could not mark job failed (jobId=${job.id}): ${errorMessage(finishErr)}`);
        outcome = "retry";
      }
    }

    if (outcome === "continue") {
      // Tick hit its budget mid-job — resume this exact job next invocation.
      scheduleSelfChain(job.id);
      break;
    }
    if (outcome === "lost" || outcome === "retry") {
      // Not ours any more, or left `running` for the reaper to resume after its
      // lease goes stale. Either way, don't chain: chaining would resume a job
      // another worker may own.
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
