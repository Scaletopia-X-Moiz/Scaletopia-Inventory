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
  /** True when the upsert matched an already-existing GHL contact (response
   * `new: false`) rather than creating a fresh one — any tags this push
   * carries were appended to that existing contact's tag list, not sent
   * in-body. False both for a genuine create (`new: true`) and for the rare
   * case GHL's response didn't include a recognizable `new` flag (see
   * extractNewFlag). */
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

/** Reads GHL's `new` flag off an upsert response (`{new: boolean, contact:
 * {...}}`, live-verified against the Internal test location 2026-08-18 —
 * `new: true` on first create, `new: false` on a dedupe match against an
 * existing contact). Absent/non-boolean (a response shape we haven't seen
 * live) is treated as "not deduped" — the same default a plain create would
 * have produced before this endpoint existed, so an unrecognized shape errs
 * toward the pre-upsert behavior rather than silently marking normal creates
 * as dedupes. */
function extractNewFlag(json: unknown): boolean | null {
  if (!json || typeof json !== "object") return null;
  const value = (json as Record<string, unknown>).new;
  return typeof value === "boolean" ? value : null;
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

/** Creates-or-updates a contact in GHL in a single call via `POST
 * /contacts/upsert`, replacing the old create-then-on-400-update path (3
 * calls for an already-existing contact: POST /contacts/ → 400 duplicate →
 * PUT /contacts/{id} → POST tags). Only the fields this call's payload
 * actually carries are sent — `pushOne` (lib/ghl/push-to-ghl.ts) already
 * omits anything unresolved via `?? undefined`, and JSON.stringify drops
 * undefined keys entirely, so a field this push has no value for is simply
 * absent from the request rather than sent as null/empty. GHL applies each
 * `customFields` entry by its `id` and leaves every other existing custom
 * field on the contact untouched, mirroring EmailBison's "patch" upsert
 * (lib/emailbison/push-to-emailbison.ts).
 *
 * CRITICAL — tags are deliberately excluded from the upsert body and sent
 * over the separate append-only `/contacts/{id}/tags` call instead. Live
 * probe against the Internal test location (2026-08-18, `.qa-tmp/` scripts,
 * not committed) confirmed `POST /contacts/upsert` **replaces** a contact's
 * tag list on a repeat call rather than appending to it (re-upserting the
 * same phone with `tags: ["b"]` after an earlier upsert with `tags: ["a"]`
 * left the contact with only `["b"]`) — the opposite of the old
 * create-then-tags-endpoint path's additive behavior. Sending tags inline
 * here would silently wipe a contact's existing tags on every re-push, so
 * this keeps the additive `appendTagsToContact` call for any push that
 * carries a tag: 1 GHL call when there's no tag, 2 when there is (both new
 * and existing contacts) — down from 3 for an existing contact with a tag
 * (was 1 for a brand-new contact with a tag before this change; that's the
 * accepted cost of not being able to trust tags to append in-body).
 *
 * `deduped` is read off the upsert response's `new` flag (also
 * live-confirmed: `true` on create, `false` on a dedupe match) via
 * extractNewFlag — see that function's doc for the fallback when the flag is
 * missing. Dedupe matching itself is entirely GHL's own server-side logic
 * (observed keying off phone on the Internal location, not email); this
 * client doesn't influence which field it matches on. */
export async function pushContactToGhl(
  credentials: GhlCredentials,
  payload: GhlContactPayload,
  deps: GhlClientDeps = {}
): Promise<PushContactResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const { tags, ...fields } = payload;

  const { status, json } = await requestWithRetry(fetchImpl, credentials, "/contacts/upsert", {
    ...fields,
    locationId: credentials.locationId,
  });

  if (status < 200 || status >= 300) {
    throw new GhlApiError(`GHL contact upsert failed with status ${status}: ${JSON.stringify(json)}`, status);
  }

  const contactId = extractContactId(json);
  if (!contactId) {
    throw new GhlApiError("GHL contact upsert succeeded but returned no contact id");
  }

  const deduped = extractNewFlag(json) === false;

  if (tags && tags.length > 0) {
    await appendTagsToContact(fetchImpl, credentials, contactId, tags);
  }

  return { contactId, deduped };
}
