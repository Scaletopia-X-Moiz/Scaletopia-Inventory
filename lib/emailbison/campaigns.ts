import "server-only";
import { EmailBisonApiError, listCampaigns, type EmailBisonCampaign, type EmailBisonClientDeps } from "@/lib/emailbison/client";
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
