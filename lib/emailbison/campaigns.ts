import "server-only";
import {
  EmailBisonApiError,
  listCampaigns,
  createCampaign,
  attachSenderEmails,
  createCampaignSchedule,
  createSequenceSteps,
  getSequenceSteps,
  updateSequenceVariants,
  resumeCampaign,
  type EmailBisonCampaign,
  type EmailBisonClientDeps,
  type EmailBisonCampaignScheduleInput,
  type EmailBisonSequenceVariantStep,
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

/** One extra ("B", "C", …) split-test variant of a sequence step —
 * subject/body only. It inherits its base step's waitInDays/threadReply (a
 * variant fires on the same schedule as the step it's a variant of). In
 * createEmailBisonCampaign it's created as its own step and then linked to its
 * base step via `variant_from_step_id`; the "B"/"C" letter is only a
 * human-facing label (in error messages), never sent on the wire. */
export interface CreateEmailBisonSequenceStepVariantInput {
  emailSubject: string;
  emailBody: string;
}

/** One sequence step for createEmailBisonCampaign — the base ("A") content
 * plus any extra split-test variants. Mirrors client.ts's
 * EmailBisonSequenceStepInput for the base fields; `extraVariants` is new and
 * has no client.ts equivalent, since each extra variant is created as its own
 * appended sequence-step and then linked in one whole-sequence PUT rather than
 * being part of the base createSequenceSteps body (see the EmailBison API flow
 * comment on createEmailBisonCampaign below). */
export interface CreateEmailBisonSequenceStepInput {
  emailSubject: string;
  emailBody: string;
  waitInDays: number;
  threadReply: boolean;
  extraVariants?: CreateEmailBisonSequenceStepVariantInput[];
}

/** Input for createEmailBisonCampaign — everything needed to run the
 * multi-call EmailBison campaign-creation sequence in one shot. `sequenceTitle`
 * defaults to `name` when omitted, matching how Clay's UI doesn't ask for a
 * separate sequence title. */
export interface CreateEmailBisonCampaignInput {
  name: string;
  senderEmailIds: string[];
  schedule: EmailBisonCampaignScheduleInput;
  steps: CreateEmailBisonSequenceStepInput[];
  sequenceTitle?: string;
  launch: boolean;
}

/** Human-facing label for the `index`th extra split-test variant, used ONLY in
 * error messages — the base step is "A", so extras are "B", "C", … (index 0 ->
 * "B"). EmailBison has no letter concept (a variant is `variant: true` +
 * `variant_from_step_id`, see client.ts), so this letter is never sent on the
 * wire; it just keeps failures readable ("...variant B for step 1 failed").
 * Falls back to a number past "Z". */
function variantLabel(index: number): string {
  return index < 25 ? String.fromCharCode("B".charCodeAt(0) + index) : `#${index + 2}`;
}

/** Orchestrates EmailBison's multi-call campaign-creation flow (issue #94's
 * "Seam" decision): createCampaign -> attachSenderEmails ->
 * createCampaignSchedule -> createSequenceSteps -> (one create + link per
 * extra split-test variant) -> (resumeCampaign, only when `input.launch` is
 * true). This is the single place that knows this sequence — route handlers
 * and UI stay thin and never call the individual client.ts functions
 * directly.
 *
 * Split-test variants (live-verified EmailBison API flow, issue #143):
 * createSequenceSteps creates every step's base ("A") content in one call, in
 * order, giving each base step an id and the campaign's single sequence id.
 * For each extra variant on a step, this then creates it as its own appended
 * sequence-step (same POST, same title) — EmailBison appends to that one
 * sequence and returns ALL steps with the new one **last**, so the new step's
 * id is read from the end of the returned array (not `[0]`) — and records
 * which base step it splits from. Once every variant step exists, one v1.1 PUT
 * of the whole sequence (updateSequenceVariants) marks each variant step
 * `variant: true` + `variant_from_step_id: <baseStepId>`, echoing every step's
 * EmailBison-assigned `order` read back via getSequenceSteps. A plain campaign
 * (no extra variants) skips the read + PUT entirely.
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

  const sequenceTitle = input.sequenceTitle ?? input.name;
  let sequenceId: string;
  let baseStepIds: string[];
  try {
    const sequence = await createSequenceSteps(
      client,
      campaign.id,
      sequenceTitle,
      input.steps.map((step) => ({
        emailSubject: step.emailSubject,
        emailBody: step.emailBody,
        waitInDays: step.waitInDays,
        threadReply: step.threadReply,
      })),
      deps
    );
    sequenceId = sequence.id;
    baseStepIds = sequence.steps.map((step) => step.id);
  } catch (err) {
    throw new EmailBisonApiError(stepFailureMessage("creating sequence steps", err));
  }

  // Create each extra variant as its own appended sequence step, recording
  // which base step it splits from (variantStepId -> baseStepId). EmailBison
  // appends to the campaign's one sequence and returns ALL steps, newest last.
  const variantBaseByStepId = new Map<string, string>();
  for (let i = 0; i < input.steps.length; i++) {
    const step = input.steps[i];
    const extraVariants = step.extraVariants ?? [];
    const baseStepId = baseStepIds[i];

    for (let v = 0; v < extraVariants.length; v++) {
      const variant = extraVariants[v];
      const letter = variantLabel(v);
      try {
        const variantSequence = await createSequenceSteps(
          client,
          campaign.id,
          sequenceTitle,
          [
            {
              emailSubject: variant.emailSubject,
              emailBody: variant.emailBody,
              waitInDays: step.waitInDays,
              threadReply: step.threadReply,
            },
          ],
          deps
        );
        const created = variantSequence.steps[variantSequence.steps.length - 1];
        if (!created) {
          throw new EmailBisonApiError("EmailBison sequence-steps create succeeded but returned no variant step id");
        }
        variantBaseByStepId.set(created.id, baseStepId);
      } catch (err) {
        throw new EmailBisonApiError(
          stepFailureMessage(`creating split test variant ${letter} for step ${i + 1}`, err)
        );
      }
    }
  }

  // Link every variant in one whole-sequence v1.1 PUT: read the sequence back
  // for its EmailBison-assigned orders, mark each variant step against its base
  // step, and echo the rest unchanged. Skipped entirely when there are none.
  if (variantBaseByStepId.size > 0) {
    try {
      const { steps } = await getSequenceSteps(client, campaign.id, deps);
      const putSteps: EmailBisonSequenceVariantStep[] = steps.map((s) => {
        const baseStepId = variantBaseByStepId.get(s.id);
        return baseStepId !== undefined
          ? { ...s, variant: true, variantFromStepId: baseStepId }
          : { ...s, variant: false };
      });
      await updateSequenceVariants(client, sequenceId, sequenceTitle, putSteps, deps);
    } catch (err) {
      throw new EmailBisonApiError(stepFailureMessage("linking split test variants", err));
    }
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
