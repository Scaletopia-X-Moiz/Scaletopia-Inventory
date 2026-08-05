import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type PushJobStatus = "queued" | "running" | "succeeded" | "failed" | "partial" | "canceled";

export interface PushJobFailure {
  name: string;
  reason: string;
}

export interface PushJob {
  id: string;
  clientId: string;
  platform: string;
  entity: string;
  action: string | null;
  campaignId: string | null;
  niche: string[];
  filters: Record<string, unknown>;
  options: Record<string, unknown>;
  status: PushJobStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  failures: PushJobFailure[];
  cursor: Record<string, unknown> | null;
  error: string | null;
  triggeredByUserId: string | null;
  triggeredByEmail: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface PushJobFilters {
  clientId?: string;
  platform?: string;
  status?: PushJobStatus;
}

export interface PushJobListResult {
  rows: PushJob[];
  total: number;
}

export interface CreatePushJobInput {
  clientId: string;
  platform: string;
  entity: string;
  action?: string | null;
  campaignId?: string | null;
  niche?: string[];
  filters: Record<string, unknown>;
  options?: Record<string, unknown>;
  triggeredByUserId?: string | null;
  triggeredByEmail?: string | null;
}

export interface RecordJobPersonOutcome {
  personId: string;
  outcome: "succeeded" | "failed";
}

const PUSH_JOB_COLUMNS =
  "id,client_id,platform,entity,action,campaign_id,niche,filters,options,status,total,processed,succeeded,failed,failures,cursor,error,triggered_by_user_id,triggered_by_email,created_at,started_at,finished_at";

interface RawPushJob {
  id: string;
  client_id: string;
  platform: string;
  entity: string;
  action: string | null;
  campaign_id: string | null;
  niche: string[] | null;
  filters: Record<string, unknown>;
  options: Record<string, unknown>;
  status: PushJobStatus;
  total: number;
  processed: number;
  succeeded: number;
  failed: number;
  failures: PushJobFailure[];
  cursor: Record<string, unknown> | null;
  error: string | null;
  triggered_by_user_id: string | null;
  triggered_by_email: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

function toPushJob(raw: RawPushJob): PushJob {
  return {
    id: raw.id,
    clientId: raw.client_id,
    platform: raw.platform,
    entity: raw.entity,
    action: raw.action,
    campaignId: raw.campaign_id,
    niche: raw.niche ?? [],
    filters: raw.filters,
    options: raw.options,
    status: raw.status,
    total: raw.total,
    processed: raw.processed,
    succeeded: raw.succeeded,
    failed: raw.failed,
    failures: raw.failures ?? [],
    cursor: raw.cursor,
    error: raw.error,
    triggeredByUserId: raw.triggered_by_user_id,
    triggeredByEmail: raw.triggered_by_email,
    createdAt: raw.created_at,
    startedAt: raw.started_at,
    finishedAt: raw.finished_at,
  };
}

/** Enqueues a new push job in `status=queued`. Trigger-time filter/options
 * snapshot is stored verbatim for audit and resume. */
export async function createPushJob(input: CreatePushJobInput): Promise<PushJob> {
  const { data, error } = await supabaseAdmin
    .from("push_jobs")
    .insert({
      client_id: input.clientId,
      platform: input.platform,
      entity: input.entity,
      action: input.action ?? null,
      campaign_id: input.campaignId ?? null,
      niche: input.niche ?? [],
      filters: input.filters,
      options: input.options ?? {},
      triggered_by_user_id: input.triggeredByUserId ?? null,
      triggered_by_email: input.triggeredByEmail ?? null,
    })
    .select(PUSH_JOB_COLUMNS)
    .single();
  if (error) throw error;
  return toPushJob(data as unknown as RawPushJob);
}

/** Fetches a single push job by id, or null if it doesn't exist. */
export async function getPushJob(id: string): Promise<PushJob | null> {
  const { data, error } = await supabaseAdmin.from("push_jobs").select(PUSH_JOB_COLUMNS).eq("id", id).single();
  if (error) {
    if (error.code === "PGRST116") return null;
    throw error;
  }
  return toPushJob(data as unknown as RawPushJob);
}

/** Claims the oldest queued job by flipping it to `running`, or null if
 * none are queued. Optimistic (status=queued guard on the update) rather
 * than a DB-level lock — sufficient for a single-worker claimer; the
 * runner issue (#120) owns any concurrency hardening beyond that. */
export async function claimNextQueuedJob(): Promise<PushJob | null> {
  const { data: candidates, error: selectError } = await supabaseAdmin
    .from("push_jobs")
    .select("id")
    .eq("status", "queued")
    .order("created_at", { ascending: true })
    .limit(1);
  if (selectError) throw selectError;
  if (!candidates || candidates.length === 0) return null;

  const candidateId = (candidates[0] as { id: string }).id;
  const { data, error } = await supabaseAdmin
    .from("push_jobs")
    .update({ status: "running", started_at: new Date().toISOString() })
    .eq("id", candidateId)
    .eq("status", "queued")
    .select(PUSH_JOB_COLUMNS)
    .single();
  if (error) {
    if (error.code === "PGRST116") return null;
    throw error;
  }
  return toPushJob(data as unknown as RawPushJob);
}

/** Returns the next job the worker should process this tick: an already-
 * `running` job first (so an invocation that ran out of time mid-run resumes
 * the same job rather than stranding it), else the oldest `queued` job via
 * claimNextQueuedJob (which flips it to `running`).
 *
 * Serialization is global FIFO — a single running job at a time across all
 * clients. Per-client serialization (letting two different clients' pushes run
 * concurrently) is issue #121; this shape doesn't preclude it — #121 refines
 * the claim predicate here without touching the worker. */
export async function getResumableJob(): Promise<PushJob | null> {
  const { data, error } = await supabaseAdmin
    .from("push_jobs")
    .select(PUSH_JOB_COLUMNS)
    .eq("status", "running")
    .order("started_at", { ascending: true })
    .limit(1);
  if (error) throw error;
  if (data && data.length > 0) {
    return toPushJob(data[0] as unknown as RawPushJob);
  }
  return claimNextQueuedJob();
}

/** Updates the live progress counters a running job reports mid-run. */
export async function updateJobProgress(
  id: string,
  progress: { total?: number; processed: number; succeeded: number; failed: number; cursor?: Record<string, unknown> | null }
): Promise<void> {
  const update: Record<string, unknown> = {
    processed: progress.processed,
    succeeded: progress.succeeded,
    failed: progress.failed,
  };
  if (progress.total !== undefined) update.total = progress.total;
  if (progress.cursor !== undefined) update.cursor = progress.cursor;

  const { error } = await supabaseAdmin.from("push_jobs").update(update).eq("id", id);
  if (error) throw error;
}

/** Marks a job terminal (succeeded/failed/partial/canceled) with its final
 * result. */
export async function finishJob(
  id: string,
  result: {
    status: Exclude<PushJobStatus, "queued" | "running">;
    succeeded: number;
    failed: number;
    failures?: PushJobFailure[];
    error?: string | null;
  }
): Promise<void> {
  const { error } = await supabaseAdmin
    .from("push_jobs")
    .update({
      status: result.status,
      succeeded: result.succeeded,
      failed: result.failed,
      failures: result.failures ?? [],
      error: result.error ?? null,
      finished_at: new Date().toISOString(),
    })
    .eq("id", id);
  if (error) throw error;
}

/** Paginated push jobs, newest first, for the Push Activity panel. */
export async function listPushJobs(filters: PushJobFilters = {}, limit = 50, offset = 0): Promise<PushJobListResult> {
  let query = supabaseAdmin.from("push_jobs").select(PUSH_JOB_COLUMNS, { count: "exact" });

  if (filters.clientId) query = query.eq("client_id", filters.clientId);
  if (filters.platform) query = query.eq("platform", filters.platform);
  if (filters.status) query = query.eq("status", filters.status);

  query = query.order("created_at", { ascending: false }).order("id", { ascending: true });

  const { data, error, count } = await query.range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = (data ?? []) as unknown as RawPushJob[];
  return { rows: rows.map(toPushJob), total: count ?? 0 };
}

/** Tags each pushed person with the job that pushed them, so People/
 * Companies can later filter to exactly one run's records. Upserts on the
 * (push_job_id, person_id) primary key so a resumed chunk can safely
 * re-report the same record. */
export async function recordJobPeople(jobId: string, outcomes: RecordJobPersonOutcome[]): Promise<void> {
  if (outcomes.length === 0) return;

  const { error } = await supabaseAdmin.from("push_job_records").upsert(
    outcomes.map((o) => ({
      push_job_id: jobId,
      person_id: o.personId,
      outcome: o.outcome,
    })),
    { onConflict: "push_job_id,person_id" }
  );
  if (error) throw error;
}
