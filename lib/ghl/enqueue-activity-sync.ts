import "server-only";
import { createPushJob, type PushJob } from "@/lib/data/push-jobs";

/** `push_jobs.platform` value for a GHL last-activity sync. Extends the
 * existing platform vocabulary rather than standing up a parallel queue — see
 * the dispatch branch in app/api/internal/push-worker/route.ts for why. */
export const GHL_ACTIVITY_PLATFORM = "ghl_activity";

export interface EnqueueGhlActivitySyncInput {
  clientId: string;
  /** Skip the incremental sweep and re-read every pushed contact directly.
   * What the manual Refresh button asks for. */
  full?: boolean;
  triggeredByUserId?: string | null;
  triggeredByEmail?: string | null;
}

/** Queues an activity sync for one client.
 *
 * `filters` is stored as `{}`: unlike a push, this job's working set is
 * "every contact this client has a GHL contact id for", which is a property
 * of the client rather than of the view the user was looking at. The column
 * is NOT NULL, hence the empty object rather than null. */
export async function enqueueGhlActivitySync(input: EnqueueGhlActivitySyncInput): Promise<PushJob> {
  return createPushJob({
    clientId: input.clientId,
    platform: GHL_ACTIVITY_PLATFORM,
    entity: "people",
    action: null,
    campaignId: null,
    niche: [],
    filters: {},
    options: { full: input.full === true },
    triggeredByUserId: input.triggeredByUserId ?? null,
    triggeredByEmail: input.triggeredByEmail ?? null,
  });
}
