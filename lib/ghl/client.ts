import "server-only";

export const GHL_API_BASE = "https://services.leadconnectorhq.com";
export const GHL_API_VERSION = "2021-07-28";

/** 429s and 5xx share a retry budget here — unlike Clay's push, GHL contact
 * creation happens one-at-a-time per person (no fixed concurrency fan-out),
 * so there's no need to split a separate rate-limit budget from the
 * transient-failure budget the way lib/clay/push-to-clay.ts does. */
export const GHL_RETRY_MAX_RETRIES = 5;
const GHL_RETRY_BASE_DELAY_MS = 500;
export const GHL_RETRY_MAX_DELAY_MS = 8_000;

const TRANSIENT_STATUSES = new Set([429, 500, 502, 503, 504]);

export interface GhlCredentials {
  apiKey: string;
  locationId: string;
}

export interface GhlContactPayload {
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  companyName?: string;
  city?: string;
  country?: string;
  tags?: string[];
  /** Custom-field values, keyed by GHL field id — GHL's contact-create API
   * accepts `{id, value}` pairs on `customFields` (plural; `customField`
   * 422s with "property customField should not exist") (ticket #51). */
  customFields?: { id: string; value: string }[];
}

export interface PushContactResult {
  contactId: string;
  /** True when GHL reported this as a duplicate contact and the payload's
   * tags were appended to the existing contact instead of a new one being
   * created. */
  deduped: boolean;
}

export class GhlApiError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "GhlApiError";
    this.status = status;
  }
}

export interface GhlClientDeps {
  fetchImpl?: typeof fetch;
}

function ghlHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
    Version: GHL_API_VERSION,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

function backoffMs(attempt: number): number {
  const exp = Math.min(GHL_RETRY_BASE_DELAY_MS * 2 ** attempt, GHL_RETRY_MAX_DELAY_MS);
  return exp + Math.random() * 250; // jitter so a burst doesn't retry in lockstep
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

interface RawResponse {
  status: number;
  json: unknown;
}

/** Shared retry/backoff loop for GHL requests (429/5xx), mirroring
 * lib/clay/push-to-clay.ts's postWithRetry. Non-transient statuses (including
 * 400) are returned rather than thrown, so callers can inspect the response
 * body — e.g. GHL's duplicate-contact 400 carries the existing contact's id
 * in `meta.contactId`, which must be recovered rather than treated as a hard
 * failure. */
async function requestWithMethodRetry(
  fetchImpl: typeof fetch,
  credentials: GhlCredentials,
  method: "GET" | "POST" | "PUT",
  path: string,
  body?: Record<string, unknown>
): Promise<RawResponse> {
  let attempt = 0;
  for (;;) {
    let resp: Response;
    try {
      resp = await fetchImpl(`${GHL_API_BASE}${path}`, {
        method,
        headers: ghlHeaders(credentials.apiKey),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      if (attempt >= GHL_RETRY_MAX_RETRIES) {
        throw new GhlApiError(err instanceof Error ? err.message : String(err));
      }
      await new Promise((r) => setTimeout(r, backoffMs(attempt)));
      attempt++;
      continue;
    }

    if (TRANSIENT_STATUSES.has(resp.status)) {
      if (attempt >= GHL_RETRY_MAX_RETRIES) {
        throw new GhlApiError(`GHL request to ${path} failed with status ${resp.status}`, resp.status);
      }
      const retryAfterMs =
        resp.status === 429 ? parseRetryAfterMs(resp.headers?.get?.("Retry-After") ?? null) : null;
      const delayMs =
        retryAfterMs != null ? Math.min(retryAfterMs, GHL_RETRY_MAX_DELAY_MS) : backoffMs(attempt);
      await new Promise((r) => setTimeout(r, delayMs));
      attempt++;
      continue;
    }

    const json = await resp.json().catch(() => null);
    return { status: resp.status, json };
  }
}

/** POSTs `body` to `path` with retry/backoff for transient failures.
 * Exported for tests: exercises the retry/backoff logic in isolation. */
export async function requestWithRetry(
  fetchImpl: typeof fetch,
  credentials: GhlCredentials,
  path: string,
  body: Record<string, unknown>
): Promise<RawResponse> {
  return requestWithMethodRetry(fetchImpl, credentials, "POST", path, body);
}

/** GETs `path` with the same retry/backoff behavior as requestWithRetry. */
export async function requestGetWithRetry(
  fetchImpl: typeof fetch,
  credentials: GhlCredentials,
  path: string
): Promise<RawResponse> {
  return requestWithMethodRetry(fetchImpl, credentials, "GET", path);
}

function extractDuplicateContactId(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const meta = (json as Record<string, unknown>).meta;
  if (!meta || typeof meta !== "object") return null;
  const contactId = (meta as Record<string, unknown>).contactId;
  return typeof contactId === "string" ? contactId : null;
}

function extractContactId(json: unknown): string | null {
  if (!json || typeof json !== "object") return null;
  const record = json as Record<string, unknown>;
  const contact = record.contact;
  if (contact && typeof contact === "object") {
    const id = (contact as Record<string, unknown>).id;
    if (typeof id === "string") return id;
  }
  return typeof record.id === "string" ? record.id : null;
}

async function appendTagsToContact(
  fetchImpl: typeof fetch,
  credentials: GhlCredentials,
  contactId: string,
  tags: string[]
): Promise<void> {
  if (tags.length === 0) return;
  const { status, json } = await requestWithRetry(fetchImpl, credentials, `/contacts/${contactId}/tags`, {
    tags,
  });
  if (status < 200 || status >= 300) {
    throw new GhlApiError(`GHL tag append failed with status ${status}: ${JSON.stringify(json)}`, status);
  }
}

/** Syncs this push's field values onto an already-existing GHL contact
 * (the duplicate-contact 400 path). Only the fields this call's payload
 * actually carries are sent — `pushOne` (lib/ghl/push-to-ghl.ts) already
 * omits anything unresolved via `?? undefined`, and JSON.stringify drops
 * undefined keys entirely, so a field this push has no value for is simply
 * absent from the request rather than sent as null/empty. GHL's contact
 * update applies each `customFields` entry by its `id` and leaves every
 * other existing custom field on the contact untouched — the same
 * this-push-only-touches-what-it-sends semantics EmailBison's "patch" upsert
 * already gives (lib/emailbison/push-to-emailbison.ts), so a second push that
 * only carries a new email verification status can't blow away an unrelated
 * custom field (e.g. "Age") a prior push set. Tags are excluded here — they
 * go through appendTagsToContact instead, which additively appends rather
 * than replacing the contact's tag list. */
async function updateExistingContact(
  fetchImpl: typeof fetch,
  credentials: GhlCredentials,
  contactId: string,
  payload: GhlContactPayload
): Promise<void> {
  const { tags: _tags, ...fields } = payload;
  const hasFields =
    fields.firstName !== undefined ||
    fields.lastName !== undefined ||
    fields.email !== undefined ||
    fields.phone !== undefined ||
    fields.companyName !== undefined ||
    fields.city !== undefined ||
    fields.country !== undefined ||
    (fields.customFields !== undefined && fields.customFields.length > 0);
  if (!hasFields) return;

  const { status, json } = await requestWithMethodRetry(
    fetchImpl,
    credentials,
    "PUT",
    `/contacts/${contactId}`,
    fields
  );
  if (status < 200 || status >= 300) {
    throw new GhlApiError(`GHL contact update failed with status ${status}: ${JSON.stringify(json)}`, status);
  }
}

/** Creates a contact in GHL for the given client credentials. A 400 response
 * carrying `meta.contactId` — GHL's signal that a contact with this
 * email/phone already exists — is treated as a soft success: this push's
 * fields are synced onto the existing contact (updateExistingContact) and its
 * tags appended (appendTagsToContact), instead of surfacing an error. */
export async function pushContactToGhl(
  credentials: GhlCredentials,
  payload: GhlContactPayload,
  deps: GhlClientDeps = {}
): Promise<PushContactResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  const { status, json } = await requestWithRetry(fetchImpl, credentials, "/contacts/", {
    ...payload,
    locationId: credentials.locationId,
  });

  if (status >= 200 && status < 300) {
    const contactId = extractContactId(json);
    if (!contactId) {
      throw new GhlApiError("GHL contact creation succeeded but returned no contact id");
    }
    return { contactId, deduped: false };
  }

  if (status === 400) {
    const duplicateContactId = extractDuplicateContactId(json);
    if (duplicateContactId) {
      await updateExistingContact(fetchImpl, credentials, duplicateContactId, payload);
      await appendTagsToContact(fetchImpl, credentials, duplicateContactId, payload.tags ?? []);
      return { contactId: duplicateContactId, deduped: true };
    }
  }

  throw new GhlApiError(`GHL contact creation failed with status ${status}: ${JSON.stringify(json)}`, status);
}
