import "server-only";
import {
  listCustomVariables,
  type EmailBisonClientDeps,
  type EmailBisonCustomVariable,
} from "@/lib/emailbison/client";
import type { EmailBisonCredentials } from "@/lib/emailbison/types";

/** In-memory cache of in-flight/completed custom-variable fetches, keyed by
 * API token. Scoped to this module's lifetime (one process/session) rather
 * than persisted, mirroring lib/ghl/custom-fields.ts's cache: the
 * custom-variables reference list is read once per workspace per push run
 * (not per person). EmailBison scopes a workspace by the API token that
 * authenticates the request, NOT by `credentials.workspaceId` (which holds
 * the shared base URL — in this app, all clients point at the same
 * send.scaletopia.io host and are differentiated only by their distinct API
 * key). Keying by workspaceId would collide every client's cache entry
 * together; keying by apiKey instead means a client's API-key change
 * naturally lands on a fresh cache entry instead of a stale one. Caching the
 * promise (not just the resolved value) also collapses concurrent callers
 * for the same API key into a single EmailBison request. */
const cache = new Map<string, Promise<EmailBisonCustomVariable[]>>();

/** Fetches a workspace's EmailBison custom variables, caching the result per
 * API key for the lifetime of this module (i.e. one session). This is the
 * UI's read-only reference list of variable names already known to the
 * target workspace — it has no effect on the push itself, it just helps
 * operators avoid mistyping a name (issue #56). */
export function getEmailBisonCustomVariables(
  credentials: EmailBisonCredentials,
  deps: EmailBisonClientDeps = {}
): Promise<EmailBisonCustomVariable[]> {
  const cached = cache.get(credentials.apiKey);
  if (cached) return cached;

  const promise = listCustomVariables(credentials, deps).catch((err) => {
    cache.delete(credentials.apiKey);
    throw err;
  });
  cache.set(credentials.apiKey, promise);
  return promise;
}

/** Clears the custom-variables cache. Exported for tests to reset state
 * between cases; not expected to be called from application code. */
export function clearEmailBisonCustomVariablesCache(): void {
  cache.clear();
}

/** Appends `variables` to the cached custom-variable list for `apiKey`, in
 * place, so any holder of a previously-resolved getEmailBisonCustomVariables
 * promise (e.g. an already-rendered "existing workspace variables" reference
 * panel, or the next push's ensureCustomVariablesExist lookup) sees the
 * newly-created variables without a refetch — same pattern as
 * lib/emailbison/campaigns.ts's appendToCampaignCache. If nothing is cached
 * yet for this API key, seeds the cache with `variables` so the next
 * getEmailBisonCustomVariables call also skips a fetch. Swallows a rejected
 * cached promise — that failure already cleared itself from the cache (see
 * getEmailBisonCustomVariables), so there is nothing to append to. */
export async function appendEmailBisonCustomVariablesCache(
  apiKey: string,
  variables: EmailBisonCustomVariable[]
): Promise<void> {
  if (variables.length === 0) return;

  const existing = cache.get(apiKey);
  if (!existing) {
    cache.set(apiKey, Promise.resolve(variables));
    return;
  }
  try {
    const current = await existing;
    current.push(...variables);
  } catch {
    // Cache already self-evicted on failure (getEmailBisonCustomVariables' .catch); nothing to append to.
  }
}
