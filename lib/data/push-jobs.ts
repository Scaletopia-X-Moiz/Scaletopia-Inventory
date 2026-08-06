import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

export type PushJobStatus = "queued" | "running" | "succeeded" | "failed" | "partial" | "canceled";

/** Per-record push outcome, as stored in `push_job_records.outcome`. Also the
 * optional sub-scope for the `pushJobId` filter (#123): restrict a job's
 * deep-linked set to only its succeeded or only its failed records. */
export type PushJobOutcome = "succeeded" | "failed";

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

/** A push job joined to the client it targets — the row shape the Push
 * Activity panel (#122) renders. `client` is null only if the referenced
 * client row was deleted. */
export interface PushJobListRow extends PushJob {
  client: { id: string; name: string | null } | null;
}

export interface PushJobListResult {
  rows: PushJobListRow[];
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

/** listPushJobs' select — the base columns plus the joined client, so the
 * Push Activity panel can show the client name in one round-trip. */
const PUSH_JOB_LIST_COLUMNS = `${PUSH_JOB_COLUMNS},client:clients(id,name)`;

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

/** The minimal push-job facts the "From push <client> · <timestamp>" deep-link
 * filter chip (#123) renders — just the client name and when the run happened,
 * so the chip labels the filter instead of showing a raw uuid. Kept a
 * self-contained projection (its own tiny select) rather than reusing the
 * fuller list-row join, so it depends only on columns present since the #119
 * schema and stays exactly the fields the chip consumes. */
export interface PushJobSummary {
  id: string;
  clientName: string | null;
  createdAt: string;
}

/** Fetches the deep-link chip's summary for a job, or null if it doesn't
 * exist. */
export async function getPushJobSummary(id: string): Promise<PushJobSummary | null> {
  const { data, error } = await supabaseAdmin
    .from("push_jobs")
    .select("id,created_at,client:clients(name)")
    .eq("id", id)
    .single();
  if (error) {
    if (error.code === "PGRST116") return null;
    throw error;
  }
  const raw = data as unknown as {
    id: string;
    created_at: string;
    client: { name: string | null } | null;
  };
  return {
    id: raw.id,
    clientName: raw.client?.name ?? null,
    createdAt: raw.created_at,
  };
}

/** Every person_id tagged by a push job in `push_job_records`, optionally
 * scoped to a single outcome (#123). Backs the People/Companies `pushJobId`
 * filter — the stable, exact per-run set (unlike a trigger-time filter replay,
 * which drifts, or `platform_pushes`, which overwrites across runs). Paged
 * manually rather than via fetchAllRows because `push_job_records` has no `id`
 * column (its PK is composite), so a large run's >1000 records still come back
 * whole. Ordering by `person_id` pins the page boundaries (fetchAllRows's
 * rationale) since the set is unioned, not sliced. */
export async function getPushJobPersonIds(
  jobId: string,
  outcome?: PushJobOutcome
): Promise<string[]> {
  const PAGE_SIZE = 1000;

  let countQuery = supabaseAdmin
    .from("push_job_records")
    .select("person_id", { count: "exact", head: true })
    .eq("push_job_id", jobId);
  if (outcome) countQuery = countQuery.eq("outcome", outcome);
  const { count, error: countError } = await countQuery;
  if (countError) throw countError;

  const total = count ?? 0;
  if (total === 0) return [];

  const pageCount = Math.ceil(total / PAGE_SIZE);
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, i) => {
      let query = supabaseAdmin.from("push_job_records").select("person_id").eq("push_job_id", jobId);
      if (outcome) query = query.eq("outcome", outcome);
      return query.order("person_id", { ascending: true }).range(i * PAGE_SIZE, i * PAGE_SIZE + PAGE_SIZE - 1);
    })
  );

  const ids: string[] = [];
  for (const page of pages) {
    if (page.error) throw page.error;
    for (const row of (page.data ?? []) as { person_id: string }[]) ids.push(row.person_id);
  }
  return ids;
}

/** Atomically claims the next runnable job — the oldest `queued` job whose
 * client has no job already `running` — flipping it to `running`, or null if
 * nothing is runnable. Delegates to the `claim_next_runnable_job` Postgres
 * function (lib/data/push-jobs.sql) so the select-and-flip is a single
 * `FOR UPDATE SKIP LOCKED` statement: two concurrent worker ticks can never
 * claim the same row, and per-client serialization is enforced in-query.
 *
 * `maxConcurrent` is an optional soft cap on total running jobs across all
 * clients (undefined/null disables it). It's best-effort — simultaneous
 * claimers each see the pre-claim count, so the live total can briefly exceed
 * the cap by the number of concurrent claimers.
 *
 * Only claims `queued` jobs. Resuming a `running` job stranded by a timed-out
 * invocation is the worker's responsibility (it self-chains by job id), not
 * this claim. */
export async function claimNextRunnableJob(maxConcurrent?: number | null): Promise<PushJob | null> {
  const { data, error } = await supabaseAdmin.rpc("claim_next_runnable_job", {
    max_concurrent: maxConcurrent ?? null,
  });
  if (error) throw error;
  const rows = (data ?? []) as unknown as RawPushJob[];
  if (rows.length === 0) return null;
  return toPushJob(rows[0]);
}

/** Reaps jobs stranded in `running` by a crashed/hard-killed invocation,
 * resetting each back to `queued` (keeping its cursor so a re-claim resumes
 * where it stranded) and returning how many were reclaimed. Delegates to the
 * `reset_stale_running_jobs` Postgres function (lib/data/push-jobs.sql): a job
 * is stale when its lease — `started_at`, renewed on every progress tick — has
 * not advanced within `staleSeconds`.
 *
 * The worker calls this once at the start of every invocation so a stranded
 * job (which permanently blocks its client's queue, and in bulk exhausts the
 * global concurrency cap for all clients) is auto-recovered within ~one cron
 * minute of its lease lapsing (ticket #137). */
export async function resetStaleRunningJobs(staleSeconds = 600): Promise<number> {
  const { data, error } = await supabaseAdmin.rpc("reset_stale_running_jobs", {
    stale_seconds: staleSeconds,
  });
  if (error) throw error;
  return ((data ?? []) as unknown[]).length;
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
    // Renew the lease. `started_at` doubles as the reaper's liveness signal
    // (#137): every tick pushes it forward, so a healthy multi-tick job is
    // never seen as stale, while a crashed invocation stops renewing it and
    // reset_stale_running_jobs reclaims the row once the lease lapses.
    started_at: new Date().toISOString(),
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

/** Paginated push jobs, newest first, joined to their client, for the Push
 * Activity panel (#122). */
export async function listPushJobs(filters: PushJobFilters = {}, limit = 50, offset = 0): Promise<PushJobListResult> {
  let query = supabaseAdmin.from("push_jobs").select(PUSH_JOB_LIST_COLUMNS, { count: "exact" });

  if (filters.clientId) query = query.eq("client_id", filters.clientId);
  if (filters.platform) query = query.eq("platform", filters.platform);
  if (filters.status) query = query.eq("status", filters.status);

  query = query.order("created_at", { ascending: false }).order("id", { ascending: true });

  const { data, error, count } = await query.range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = (data ?? []) as unknown as (RawPushJob & { client: { id: string; name: string | null } | null })[];
  return {
    rows: rows.map((raw) => ({ ...toPushJob(raw), client: raw.client ?? null })),
    total: count ?? 0,
  };
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
