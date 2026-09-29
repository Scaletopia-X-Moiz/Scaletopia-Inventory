import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type ImportJobStatus = "queued" | "running" | "succeeded" | "failed" | "partial" | "canceled";

/** One target-table pass of an import job. A company-sync import has two, in
 * order: companies first, then people (people's domain -> company_id lookup
 * needs the companies committed). */
export interface ImportJobStage {
  targetTable: "companies" | "people";
  columnMap: Record<string, string>;
}

/** A finished stage's outcome, appended to `import_jobs.stage_results` when the
 * stage completes (and its `import_history` row is written). */
export interface ImportStageResult {
  targetTable: "companies" | "people";
  inputCount: number;
  dedupedCount: number;
  inserted: number;
  updated: number;
  failed: number;
  historyId: string | null;
}

/** Resume position: which stage, and the index into that stage's DEDUPED list. */
export interface ImportJobCursor {
  stage: number;
  offset: number;
}

export interface ImportJobSummary {
  id: string;
  status: ImportJobStatus;
  sourceKey: string;
  tags: string[];
  stages: ImportJobStage[];
  storagePath: string;
  fileName: string | null;
  rowCount: number;
  cursor: ImportJobCursor | null;
  stageResults: ImportStageResult[];
  /** Deduped count of the CURRENT stage. */
  total: number;
  /** Offset within the CURRENT stage. */
  processed: number;
  /** Running totals for the CURRENT stage (earlier stages are in stageResults). */
  inserted: number;
  updated: number;
  failed: number;
  error: string | null;
  triggeredByUserId: string | null;
  triggeredByEmail: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

/** A job including the current stage's (capped) failed records. Only the worker
 * and the lazy failed-records endpoint load this; the list never does. */
export interface ImportJob extends ImportJobSummary {
  failedRecords: Record<string, unknown>[];
}

export interface CreateImportJobInput {
  sourceKey: string;
  tags: string[];
  stages: ImportJobStage[];
  storagePath: string;
  fileName?: string | null;
  rowCount?: number;
  triggeredByUserId?: string | null;
  triggeredByEmail?: string | null;
}

export interface ImportJobListResult {
  rows: ImportJobSummary[];
  total: number;
}

/** Every import_jobs column EXCEPT `failed_records`: an uncapped-in-spirit jsonb
 * that can be megabytes per job (same reason /api/import/history omits it).
 * Fetched lazily per job via getImportJobFailedRecords. */
const IMPORT_JOB_SUMMARY_COLUMNS =
  "id,status,source_key,tags,stages,storage_path,file_name,row_count,cursor,stage_results,total,processed,inserted,updated,failed,error,triggered_by_user_id,triggered_by_email,created_at,started_at,finished_at";

const IMPORT_JOB_COLUMNS = `${IMPORT_JOB_SUMMARY_COLUMNS},failed_records`;

interface RawImportJob {
  id: string;
  status: ImportJobStatus;
  source_key: string;
  tags: string[] | null;
  stages: ImportJobStage[] | null;
  storage_path: string;
  file_name: string | null;
  row_count: number | null;
  cursor: ImportJobCursor | null;
  stage_results: ImportStageResult[] | null;
  total: number | null;
  processed: number | null;
  inserted: number | null;
  updated: number | null;
  failed: number | null;
  failed_records?: Record<string, unknown>[] | null;
  error: string | null;
  triggered_by_user_id: string | null;
  triggered_by_email: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export function toImportJobSummary(raw: RawImportJob): ImportJobSummary {
  return {
    id: raw.id,
    status: raw.status,
    sourceKey: raw.source_key,
    tags: raw.tags ?? [],
    stages: raw.stages ?? [],
    storagePath: raw.storage_path,
    fileName: raw.file_name,
    rowCount: raw.row_count ?? 0,
    cursor: raw.cursor,
    stageResults: raw.stage_results ?? [],
    total: raw.total ?? 0,
    processed: raw.processed ?? 0,
    inserted: raw.inserted ?? 0,
    updated: raw.updated ?? 0,
    failed: raw.failed ?? 0,
    error: raw.error,
    triggeredByUserId: raw.triggered_by_user_id,
    triggeredByEmail: raw.triggered_by_email,
    createdAt: raw.created_at,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
  };
}

export function toImportJob(raw: RawImportJob): ImportJob {
  return { ...toImportJobSummary(raw), failedRecords: raw.failed_records ?? [] };
}

/** Enqueues a new import job in `status=queued`, cursor at stage 0 / offset 0. */
export async function createImportJob(input: CreateImportJobInput): Promise<ImportJob> {
  const { data, error } = await supabaseAdmin
    .from("import_jobs")
    .insert({
      source_key: input.sourceKey,
      tags: input.tags,
      stages: input.stages,
      storage_path: input.storagePath,
      file_name: input.fileName ?? null,
      row_count: input.rowCount ?? 0,
      cursor: { stage: 0, offset: 0 },
      triggered_by_user_id: input.triggeredByUserId ?? null,
      triggered_by_email: input.triggeredByEmail ?? null,
    })
    .select(IMPORT_JOB_COLUMNS)
    .single();
  if (error) throw error;
  return toImportJob(data as unknown as RawImportJob);
}

/** Fetches a single import job (including its current stage's failed records),
 * or null if it doesn't exist. */
export async function getImportJob(id: string): Promise<ImportJob | null> {
  const { data, error } = await supabaseAdmin.from("import_jobs").select(IMPORT_JOB_COLUMNS).eq("id", id).single();
  if (error) {
    if (error.code === "PGRST116") return null;
    throw error;
  }
  return toImportJob(data as unknown as RawImportJob);
}

/** Lazy load of just the current stage's failed records — backs the queue
 * card's "Download failed records". Null if the job doesn't exist. */
export async function getImportJobFailedRecords(id: string): Promise<Record<string, unknown>[] | null> {
  const { data, error } = await supabaseAdmin.from("import_jobs").select("failed_records").eq("id", id).single();
  if (error) {
    if (error.code === "PGRST116") return null;
    throw error;
  }
  return ((data as { failed_records: Record<string, unknown>[] | null }).failed_records ?? []) as Record<
    string,
    unknown
  >[];
}

/** Atomically claims the oldest `queued` import job — only when no import job
 * is already `running` (a global mutex) — flipping it to `running`, or null if
 * nothing is runnable. Delegates to the `claim_next_import_job` Postgres
 * function (lib/data/import-jobs.sql), which serializes claimers with an
 * advisory lock so two simultaneous claims can never both win. Only claims
 * `queued` jobs; resuming a `running` job is the worker's job (self-chain). */
export async function claimNextImportJob(): Promise<ImportJob | null> {
  const { data, error } = await supabaseAdmin.rpc("claim_next_import_job");
  if (error) throw error;
  const rows = (data ?? []) as unknown as RawImportJob[];
  if (rows.length === 0) return null;
  return toImportJob(rows[0]);
}

/** Stale-lease window. MUST stay greater than the worker route's
 * `maxDuration` (300s) so a still-live invocation is never reaped, and match
 * the default in lib/data/import-jobs.sql (`reset_stale_import_jobs`). The
 * worker also renews the lease from a 30s interval for the whole tick. */
export const IMPORT_JOB_STALE_SECONDS = 360;

/** Reaps import jobs stranded in `running` by a crashed/hard-killed invocation
 * (lease `started_at` not renewed within `staleSeconds`), resetting each to
 * `queued` with its cursor intact, and returns how many were reclaimed. */
export async function resetStaleImportJobs(staleSeconds = IMPORT_JOB_STALE_SECONDS): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("reset_stale_import_jobs", {
    stale_seconds: staleSeconds,
  });
  if (error) throw error;
  return ((data ?? []) as unknown[]).length;
}

/** Renews only a running job's lease (`started_at`) — the interval heartbeat
 * that covers a whole tick. Writes nothing else, so it can't clobber the
 * counters. Conditional on `status = 'running'`: resolves false (0 rows) when
 * the job was reaped/finished under us, meaning this worker no longer owns it.
 *
 * Every write-back below follows the same rule (`true` = applied, `false` =
 * job no longer running, stop quietly) so a reaped worker can never overwrite
 * the new owner's state. */
export async function touchImportJobLease(id: string): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("import_jobs")
    .update({ started_at: new Date().toISOString() })
    .eq("id", id)
    .eq("status", "running")
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Persists the live progress of the CURRENT stage after a tick that did not
 * finish it, and renews the lease. */
export async function updateImportJobProgress(
  id: string,
  progress: {
    total: number;
    processed: number;
    inserted: number;
    updated: number;
    failed: number;
    failedRecords: Record<string, unknown>[];
    cursor: ImportJobCursor;
  }
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("import_jobs")
    .update({
      total: progress.total,
      processed: progress.processed,
      inserted: progress.inserted,
      updated: progress.updated,
      failed: progress.failed,
      failed_records: progress.failedRecords,
      cursor: progress.cursor,
      started_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "running")
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Moves a job to its next stage: stores the finished stage's result (the
 * caller passes the full, already-appended `stageResults`), resets the
 * per-stage counters and failed records, and points the cursor at
 * `{ stage: nextStage, offset: 0 }`. Renews the lease. */
export async function advanceImportJobStage(
  id: string,
  next: { stageResults: ImportStageResult[]; nextStage: number }
): Promise<boolean> {
  const { data, error } = await supabaseAdmin
    .from("import_jobs")
    .update({
      stage_results: next.stageResults,
      cursor: { stage: next.nextStage, offset: 0 },
      total: 0,
      processed: 0,
      inserted: 0,
      updated: 0,
      failed: 0,
      failed_records: [],
      started_at: new Date().toISOString(),
    })
    .eq("id", id)
    .eq("status", "running")
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Marks a running job terminal (succeeded/failed/partial/canceled) with its
 * final result. Stage counters/`failed_records` keep the last stage's values.
 * Resolves false when the job was no longer `running` (nothing written); the
 * caller must then NOT delete the job's CSV. */
export async function finishImportJob(
  id: string,
  result: {
    status: Exclude<ImportJobStatus, "queued" | "running">;
    stageResults: ImportStageResult[];
    total?: number;
    processed?: number;
    inserted: number;
    updated: number;
    failed: number;
    failedRecords?: Record<string, unknown>[];
    error?: string | null;
  }
): Promise<boolean> {
  const update: Record<string, unknown> = {
    status: result.status,
    stage_results: result.stageResults,
    inserted: result.inserted,
    updated: result.updated,
    failed: result.failed,
    error: result.error ?? null,
    finished_at: new Date().toISOString(),
  };
  if (result.total !== undefined) update.total = result.total;
  if (result.processed !== undefined) update.processed = result.processed;
  if (result.failedRecords !== undefined) update.failed_records = result.failedRecords;

  const { data, error } = await supabaseAdmin
    .from("import_jobs")
    .update(update)
    .eq("id", id)
    .eq("status", "running")
    .select("id");
  if (error) throw error;
  return (data ?? []).length > 0;
}

/** Paginated import jobs, newest first, for the Import Queue view. Never
 * selects `failed_records`. */
export async function listImportJobs(limit = 50, offset = 0): Promise<ImportJobListResult> {
  const { data, error, count } = await supabaseAdmin
    .from("import_jobs")
    .select(IMPORT_JOB_SUMMARY_COLUMNS, { count: "exact" })
    .order("created_at", { ascending: false })
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = (data ?? []) as unknown as RawImportJob[];
  return { rows: rows.map(toImportJobSummary), total: count ?? 0 };
}
