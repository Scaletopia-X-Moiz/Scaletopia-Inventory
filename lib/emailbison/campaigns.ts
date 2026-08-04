import "server-only";
import {
  EmailBisonApiError,
  listCampaigns,
  createCampaign,
  attachSenderEmails,
  createCampaignSchedule,
  createSequenceSteps,
  resumeCampaign,
  type EmailBisonCampaign,
  type EmailBisonClientDeps,
  type EmailBisonCampaignScheduleInput,
  type EmailBisonSequenceStepInput,
} from "@/lib/emailbison/client";
import type { EmailBisonCredentials } from "@/lib/emailbison/types";

/** Hard cap on pages walked per fetch. `hasMore` is derived from
 * `meta.current_page`/`meta.last_page` (lib/emailbison/client.ts), whose
 * exact shape is unconfirmed against a live token (api-research.md) — this
 * bound turns a malformed/inconsistent envelope into an error instead of an
 * unbounded fetch loop. Comfortably above any workspace's real campaign
 * count at a reasonable page size. */
const MAX_CAMPAIGN_PAGES = 200;

/** In-memory cache of in-flight/completed campaign-list fetches, keyed by
 * client id (one client == one EmailBison workspace) — same
 * promise-caching, per-client, module-lifetime convention as
 * lib/ghl/custom-fields.ts's getGhlCustomFields. */
const cache = new Map<string, Promise<EmailBisonCampaign[]>>();

async function fetchAllCampaigns(
  credentials: EmailBisonCredentials,
  deps: EmailBisonClientDeps
): Promise<EmailBisonCampaign[]> {
  const campaigns: EmailBisonCampaign[] = [];
  let page = 1;
  for (;;) {
    const result = await listCampaigns(credentials, page, deps);
    campaigns.push(...result.campaigns);
    if (!result.hasMore) break;
    if (page >= MAX_CAMPAIGN_PAGES) {
      throw new EmailBisonApiError(`EmailBison campaign list exceeded ${MAX_CAMPAIGN_PAGES} pages`);
    }
    page++;
  }
  return campaigns;
}

/** Fetches a client's full (all-pages) EmailBison campaign list, caching
 * the result per client for the lifetime of this module (i.e. one session)
 * so the campaign picker dropdown used by Add to Campaign can call this
 * without refetching on every render — only a workspace (client) change
 * triggers a refetch. */
export function getEmailBisonCampaigns(
  client: { id: string } & EmailBisonCredentials,
  deps: EmailBisonClientDeps = {}
): Promise<EmailBisonCampaign[]> {
  const cached = cache.get(client.id);
  if (cached) return cached;

  const promise = fetchAllCampaigns(client, deps).catch((err) => {
    cache.delete(client.id);
    throw err;
  });
  cache.set(client.id, promise);
  return promise;
}

/** Clears the campaign-list cache. Exported for tests to reset state
 * between cases; not expected to be called from application code. */
export function clearEmailBisonCampaignsCache(): void {
  cache.clear();
}

/** Appends `campaign` to the cached campaign-list array for `clientId`, in
 * place, so any holder of a previously-resolved getEmailBisonCampaigns
 * promise (e.g. an already-rendered dropdown) sees the new campaign without
 * a refetch. If nothing is cached yet for this client, seeds the cache with
 * a single-campaign array so the next getEmailBisonCampaigns call also skips
 * a fetch. Swallows a rejected cached promise — that failure already cleared
 * itself from the cache (see getEmailBisonCampaigns), so there is nothing to
 * append to. */
async function appendToCampaignCache(clientId: string, campaign: EmailBisonCampaign): Promise<void> {
  const existing = cache.get(clientId);
  if (!existing) {
    cache.set(clientId, Promise.resolve([campaign]));
    return;
  }
  try {
    const campaigns = await existing;
    campaigns.push(campaign);
  } catch {
    // Cache already self-evicted on failure (getEmailBisonCampaigns' .catch); nothing to append to.
  }
}

function stepFailureMessage(step: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `Campaign created but ${step} failed: ${message}`;
}

/** Input for createEmailBisonCampaign — everything needed to run the
 * multi-call EmailBison campaign-creation sequence in one shot. `sequenceTitle`
 * defaults to `name` when omitted, matching how Clay's UI doesn't ask for a
 * separate sequence title. */
export interface CreateEmailBisonCampaignInput {
  name: string;
  senderEmailIds: string[];
  schedule: EmailBisonCampaignScheduleInput;
  steps: EmailBisonSequenceStepInput[];
  sequenceTitle?: string;
  launch: boolean;
}

/** Orchestrates EmailBison's multi-call campaign-creation flow (issue #94's
 * "Seam" decision): createCampaign -> attachSenderEmails ->
 * createCampaignSchedule -> createSequenceSteps -> (resumeCampaign, only when
 * `input.launch` is true). This is the single place that knows this
 * sequence — route handlers and UI stay thin and never call the individual
 * client.ts functions directly.
 *
 * Stops at the first failing step and throws an error naming which step
 * failed (e.g. "Campaign created but attaching senders failed: ..."). No
 * rollback/delete of the partially-created campaign is attempted — it stays
 * visible in EmailBison in whatever partial state it reached.
 *
 * On success, appends the new campaign to this module's in-memory cache in
 * place, so a subsequent getEmailBisonCampaigns call for this client sees it
 * without a new fetch. */
export async function createEmailBisonCampaign(
  client: { id: string } & EmailBisonCredentials,
  input: CreateEmailBisonCampaignInput,
  deps: EmailBisonClientDeps = {}
): Promise<EmailBisonCampaign> {
  let campaign: EmailBisonCampaign;
  try {
    campaign = await createCampaign(client, input.name, deps);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new EmailBisonApiError(`Creating campaign failed: ${message}`);
  }

  try {
    await attachSenderEmails(client, campaign.id, input.senderEmailIds, deps);
  } catch (err) {
    throw new EmailBisonApiError(stepFailureMessage("attaching senders", err));
  }

  try {
    await createCampaignSchedule(client, campaign.id, input.schedule, deps);
  } catch (err) {
    throw new EmailBisonApiError(stepFailureMessage("creating the schedule", err));
  }

  try {
    await createSequenceSteps(client, campaign.id, input.sequenceTitle ?? input.name, input.steps, deps);
  } catch (err) {
    throw new EmailBisonApiError(stepFailureMessage("creating sequence steps", err));
  }

  if (input.launch) {
    try {
      await resumeCampaign(client, campaign.id, deps);
    } catch (err) {
      throw new EmailBisonApiError(stepFailureMessage("launching (resume) the campaign", err));
    }
  }

  await appendToCampaignCache(client.id, campaign);
  return campaign;
}
