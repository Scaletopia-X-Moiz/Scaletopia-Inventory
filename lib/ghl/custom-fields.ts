import "server-only";
import { requestGetWithRetry, GhlApiError, type GhlCredentials, type GhlClientDeps } from "@/lib/ghl/client";

export interface GhlCustomField {
  id: string;
  name: string;
  fieldKey: string;
  dataType: string;
}

interface RawCustomField {
  id: string;
  name: string;
  fieldKey: string;
  dataType: string;
}

function toCustomField(raw: RawCustomField): GhlCustomField {
  return { id: raw.id, name: raw.name, fieldKey: raw.fieldKey, dataType: raw.dataType };
}

function extractCustomFields(json: unknown): GhlCustomField[] {
  if (!json || typeof json !== "object") return [];
  const customFields = (json as Record<string, unknown>).customFields;
  if (!Array.isArray(customFields)) return [];
  return (customFields as RawCustomField[]).map(toCustomField);
}

/** In-memory cache of in-flight/completed custom-field fetches, keyed by
 * client id. Scoped to this module's lifetime (one process/session) rather
 * than persisted, since the field-mapping step calls this once per client
 * per push run rather than once per contact — caching the promise (not just
 * the resolved value) also collapses concurrent callers for the same client
 * into a single GHL request. */
const cache = new Map<string, Promise<GhlCustomField[]>>();

async function fetchGhlCustomFields(
  credentials: GhlCredentials,
  deps: GhlClientDeps
): Promise<GhlCustomField[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { status, json } = await requestGetWithRetry(
    fetchImpl,
    credentials,
    `/locations/${credentials.locationId}/customFields`
  );

  if (status < 200 || status >= 300) {
    throw new GhlApiError(`GHL custom-fields fetch failed with status ${status}: ${JSON.stringify(json)}`, status);
  }

  return extractCustomFields(json);
}

/** Fetches a client's GHL custom fields, caching the result per client for
 * the lifetime of this module (i.e. one session) so the field-mapping step
 * can call this per client rather than per contact without refetching. */
export function getGhlCustomFields(
  client: { id: string } & GhlCredentials,
  deps: GhlClientDeps = {}
): Promise<GhlCustomField[]> {
  const cached = cache.get(client.id);
  if (cached) return cached;

  const promise = fetchGhlCustomFields(client, deps).catch((err) => {
    cache.delete(client.id);
    throw err;
  });
  cache.set(client.id, promise);
  return promise;
}

/** Clears the custom-fields cache. Exported for tests to reset state between
 * cases; not expected to be called from application code. */
export function clearGhlCustomFieldsCache(): void {
  cache.clear();
}
