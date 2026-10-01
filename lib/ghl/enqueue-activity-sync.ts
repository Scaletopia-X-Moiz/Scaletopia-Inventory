import "server-only";
import { createPushJob, type PushJob } from "@/lib/data/push-jobs";
import { RETRY_ATTEMPT_OPTION_KEY, type ActivityScope } from "@/lib/ghl/activity-scope";

/** `push_jobs.platform` value for a GHL last-activity sync. Extends the
 * existing platform vocabulary rather than standing up a parallel queue — see
 * the dispatch branch in app/api/internal/push-worker/route.ts for why. */
export const GHL_ACTIVITY_PLATFORM = "ghl_activity";

export interface EnqueueGhlActivitySyncInput {
  /** Pre-chosen job id — see CreatePushJobInput.id. The filter-scoped refresh
   * writes this job's queue rows before creating the job row, so the id has
   * to exist first. */
  id?: string;
  clientId: string;
  /** Skip the incremental sweep and re-read every pushed contact directly.
   * What the manual Refresh button asks for. */
  full?: boolean;
  /** What this job is allowed to look at (Decision 4). Omitted means the
   * client's whole pushed set, which is the pre-existing behaviour.
   *
   * ONE job per client, never one job looping clients (Decision 1):
   * `push_jobs.client_id` is NOT NULL and the claim RPC serializes on it (and
   * now on the client's GHL location), which is the only thing keeping a sync
   * and a push from fighting over one location's burst budget. A job spanning
   * clients would run outside that guard. */
  scope?: ActivityScope;
  /** Only read contacts that could plausibly have messages (Decision 5,
   * layer 1). Set by the post-push auto-sync. */
  dedupedOnly?: boolean;
  /** Retries this work list has already spent, carried forward onto a
   * continuation job so the chain remembers. Without it a continuation would
   * start its attempt count from zero and a deterministically-failing
   * partition would resurrect itself forever — see
   * MAX_ACTIVITY_RETRY_ATTEMPTS. Omitted (0) for an ordinary first run. */
  retryAttempt?: number;
  triggeredByUserId?: string | null;
  triggeredByEmail?: string | null;
}

/** Queues an activity sync for one client.
 *
 * `filters` is stored as `{}`: unlike a push, this job's working set is a
 * property of the client (or of the explicit `scope`), not of the view the
 * user was looking at. The column is NOT NULL, hence the empty object rather
 * than null.
 *
 * A `kind: "ids"` scope is stored verbatim in `options` — bounded at
 * MAX_TARGETED_IDS (2,000 uuids, ~74 KB) precisely so that it can be. */
export async function enqueueGhlActivitySync(input: EnqueueGhlActivitySyncInput): Promise<PushJob> {
  return createPushJob({
    id: input.id,
    clientId: input.clientId,
    platform: GHL_ACTIVITY_PLATFORM,
    entity: "people",
    action: null,
    campaignId: null,
    niche: [],
    filters: {},
    options: {
      full: input.full === true,
      ...(input.scope ? { scope: input.scope } : {}),
      ...(input.dedupedOnly ? { dedupedOnly: true } : {}),
      ...(input.retryAttempt ? { [RETRY_ATTEMPT_OPTION_KEY]: input.retryAttempt } : {}),
    },
    triggeredByUserId: input.triggeredByUserId ?? null,
    triggeredByEmail: input.triggeredByEmail ?? null,
  });
}
