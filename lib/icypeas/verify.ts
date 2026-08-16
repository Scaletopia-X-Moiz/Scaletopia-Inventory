import "server-only";
import crypto from "node:crypto";

/** Icypeas email verification.
 * https://api-doc.icypeas.com/find-emails/email-verification/
 *
 * Unlike MillionVerifier's real-time GET, Icypeas is ASYNCHRONOUS: submitting
 * a job only returns an acknowledgement (`{ item: { _id, status: "NONE" } }`);
 * the actual verdict shows up later, either via a webhook we register
 * (`custom.webhookUrl`) or by polling `bulk-single-searchs/read` with the
 * returned `_id` until the item reaches a terminal status. See
 * docs/reports/icypeas-api-research.md for the full research this module is
 * built from — treat that doc as the source of truth for anything not
 * commented here.
 *
 * `pollUntilTerminal` exists for local dev (no public URL to receive a
 * webhook) and as a safety net; production writes come from the webhook
 * receiver at app/api/internal/icypeas-webhook/route.ts. */
const API_BASE = "https://app.icypeas.com/api";

/** Default poll cadence/budget for pollUntilTerminal. The read route is
 * rate-limited to 30 calls/min (~1 every 2s) per the research doc §6, so
 * 2000ms is the safe floor for a single poller; timeoutMs is a generous
 * guess since Icypeas doesn't document per-email latency. */
const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_POLL_TIMEOUT_MS = 30_000;

/** The new email_status vocabulary (decision: adopt Icypeas's confidence
 * scale directly rather than force-fitting it into the old
 * ok/catch_all/invalid/unknown/disposable set, which Icypeas cannot
 * reproduce — see research doc §5c "mapping gaps"). `verifying` is a
 * transient marker written the moment a job is submitted, before any verdict
 * exists; it is never returned by mapCertainty, only set directly by
 * reverify.ts. */
export const EMAIL_STATUSES = new Set([
  "ultra_sure",
  "very_sure",
  "probable",
  "undeliverable",
  "not_found",
]);

/** Written to email_status the instant a verification job is submitted, so
 * the UI can show "verifying…" instead of a stale prior status while the
 * webhook/poll resolves. Not a member of EMAIL_STATUSES (it's not a verdict,
 * it's a lifecycle marker) but exported here since it's part of the same
 * status vocabulary the badge renders. */
export const VERIFYING_STATUS = "verifying";

export interface VerifyResult {
  /** The email that was verified. Icypeas's result item doesn't echo the
   * input email back on the email-verification results item the way
   * MillionVerifier does, so this is the email we sent, not one read off the
   * response. */
  email: string;
  /** One of EMAIL_STATUSES — write straight into email_status. */
  status: string;
  /** The raw Icypeas certainty token, kept for debugging/audit (this is what
   * `status` was derived from, sans the not_found/BAD_INPUT special cases). */
  certainty: string | null;
  /** Icypeas never returns remaining credits in a verification response
   * (research doc §6) — always null. Kept on the shape so callers/UI that
   * read MillionVerifier's `credits` field degrade gracefully instead of
   * breaking. */
  credits: number | null;
}

export interface VerifyDeps {
  fetchImpl?: typeof fetch;
  /** Override for tests; defaults to process.env.ICYPEAS_API_KEY. */
  apiKey?: string;
  /** Override for tests; defaults to process.env.ICYPEAS_API_SECRET. Only
   * used by verifyWebhookSignature. */
  apiSecret?: string;
}

/** A company `email` column can hold several comma-separated addresses; only
 * the first is verified. Returns null when there's nothing to verify.
 * Ported verbatim from lib/millionverifier/verify.ts. */
export function firstEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const first = raw.split(",")[0]?.trim();
  return first ? first : null;
}

function apiKeyOrThrow(deps: VerifyDeps): string {
  const apiKey = deps.apiKey ?? process.env.ICYPEAS_API_KEY;
  if (!apiKey) throw new Error("ICYPEAS_API_KEY is not set");
  return apiKey;
}

// ---------------------------------------------------------------------------
// Submit
// ---------------------------------------------------------------------------

interface SubmitAckResponse {
  success?: boolean;
  item?: { _id?: string; status?: string };
  // Validation-error shape is not captured verbatim in the research doc
  // (rendered in a hidden docs tab) — defend against it defensively below.
  // TODO: confirm exact validation-error JSON against a live response.
  message?: string;
  error?: string;
}

export interface SubmitOptions {
  /** Our tracking id, encoded as `${table}:${id}` by callers (reverify.ts) so
   * the webhook receiver can find the row to update without a side table.
   * Echoed back by Icypeas as userData.externalId. */
  externalId?: string;
  /** Per-search webhook URL. Only set when a public base URL is configured
   * (see lib/icypeas/webhook-url.ts-equivalent logic in reverify.ts) —
   * Icypeas can't call back to localhost. */
  webhookUrl?: string;
  deps?: VerifyDeps;
}

/** Submit an email for verification. Returns the Icypeas item id to poll (or
 * to correlate against an incoming webhook). Throws on a missing key,
 * network failure, or a non-success acknowledgement — callers should treat a
 * throw as "nothing was submitted, status unchanged". */
export async function submitEmailVerification(
  email: string,
  { externalId, webhookUrl, deps = {} }: SubmitOptions = {}
): Promise<{ id: string }> {
  const apiKey = apiKeyOrThrow(deps);

  const trimmed = email.trim();
  if (!trimmed) throw new Error("No email address to verify");

  const fetchImpl = deps.fetchImpl ?? fetch;

  const custom: Record<string, string> = {};
  if (externalId) custom.externalId = externalId;
  if (webhookUrl) custom.webhookUrl = webhookUrl;

  const body: Record<string, unknown> = { email: trimmed };
  if (Object.keys(custom).length > 0) body.custom = custom;

  const resp = await fetchImpl(`${API_BASE}/email-verification`, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  // Icypeas models some validation errors as HTTP 200 with an error-carrying
  // body (research doc §7, mirroring MillionVerifier's error-in-200 pattern),
  // so a non-ok status is checked first but a 200 body is still inspected.
  if (!resp.ok) {
    throw new Error(`Icypeas email-verification returned HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as SubmitAckResponse;

  if (data.success === false || data.error) {
    throw new Error(`Icypeas: ${data.error ?? data.message ?? "submit failed"}`);
  }

  const id = data.item?._id;
  if (!id) {
    throw new Error("Icypeas did not return an item id to poll");
  }

  return { id };
}

// ---------------------------------------------------------------------------
// Fetch result
// ---------------------------------------------------------------------------

export interface RawEmailEntry {
  email?: string;
  certainty?: string;
  mxProvider?: string;
  mxRecords?: string[];
}

/** The result item shape as reconstructed from the webhook "each item
 * update" page (research doc §3b) — the `read` route wraps this in an outer
 * envelope whose exact key wasn't captured verbatim in the docs (likely
 * `items`). fetchResult below defensively unwraps several plausible shapes.
 * TODO: confirm the outer envelope key of POST /bulk-single-searchs/read
 * against a live response. */
export interface RawItem {
  _id?: string;
  status?: string;
  results?: {
    emails?: RawEmailEntry[];
    [key: string]: unknown;
  };
  userData?: { externalId?: string; webhookUrl?: string };
  [key: string]: unknown;
}

interface ReadResponse {
  success?: boolean;
  item?: RawItem;
  items?: RawItem[];
  data?: RawItem | RawItem[];
  [key: string]: unknown;
}

/** Pulls a single RawItem out of whatever envelope shape the `read` route
 * actually uses. Handles the plausible shapes: `{ item }`, `{ items: [...] }`,
 * `{ data: item }`, `{ data: [item] }`, or the bare item itself. */
function unwrapItem(data: ReadResponse): RawItem | null {
  if (data.item) return data.item;
  if (Array.isArray(data.items) && data.items.length > 0) return data.items[0];
  if (data.data) {
    return Array.isArray(data.data) ? (data.data[0] ?? null) : data.data;
  }
  // Bare item (has its own _id/status at the top level) — the read route may
  // not wrap single-id lookups in an envelope at all.
  if (typeof data.status === "string" || typeof data._id === "string") {
    return data as unknown as RawItem;
  }
  return null;
}

/** Fetch the current state of a submitted verification job by its Icypeas
 * item id. Used both by pollUntilTerminal and directly if a caller just
 * wants a one-shot status check. Throws on a missing key, network failure,
 * or an item that can't be found. */
export async function fetchResult(id: string, deps: VerifyDeps = {}): Promise<RawItem> {
  const apiKey = apiKeyOrThrow(deps);
  const fetchImpl = deps.fetchImpl ?? fetch;

  const resp = await fetchImpl(`${API_BASE}/bulk-single-searchs/read`, {
    method: "POST",
    headers: {
      Authorization: apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ id }),
  });

  if (!resp.ok) {
    throw new Error(`Icypeas bulk-single-searchs/read returned HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as ReadResponse;
  const item = unwrapItem(data);
  if (!item) {
    throw new Error(`Icypeas read returned no item for id ${id}`);
  }
  return item;
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Item lifecycle statuses that mean "still working" — poll again.
 * Research doc §5a. */
const NON_TERMINAL_STATUSES = new Set(["NONE", "SCHEDULED", "IN_PROGRESS"]);

/** Item statuses that are errors — no verdict was produced, do not overwrite
 * the row's email_status. Research doc §5c: BAD_INPUT is treated as an error
 * (not written as a bogus status) per the task's explicit decision #2;
 * INSUFFICIENT_FUNDS/ABORTED must throw per the same decision. */
const ERROR_STATUSES = new Set(["BAD_INPUT", "INSUFFICIENT_FUNDS", "ABORTED"]);

/** Terminal "no result" statuses — the job finished but found nothing.
 * Research doc §5a/§5c: maps to `not_found`, same as certainty `not_found`. */
const NOT_FOUND_STATUSES = new Set(["NOT_FOUND", "DEBITED_NOT_FOUND"]);

/** Terminal "found a result" statuses — read the verdict from
 * results.emails[0].certainty. */
const FOUND_STATUSES = new Set(["FOUND", "DEBITED"]);

export interface MappedCertainty {
  /** One of EMAIL_STATUSES, or null if the item is still non-terminal (poll
   * again / wait for the webhook). */
  status: string | null;
  /** True once `status` is a final verdict (or the item errored) and no
   * further polling/waiting is needed. */
  terminal: boolean;
  /** Raw certainty token from the response, if any, kept for VerifyResult. */
  certainty: string | null;
  /** The email address in the result (may differ in case/whitespace from
   * what we submitted), if present. */
  email: string | null;
}

/** Pure mapping fn: Icypeas RawItem -> our email_status vocabulary. Does not
 * throw — ERROR_STATUSES are surfaced via `terminal: true, status: null`
 * plus the raw item.status so callers can decide to throw with a message
 * (mapCertainty itself has no message-building context). See
 * mapCertaintyOrThrow below for the throwing variant callers actually use. */
export function mapCertainty(item: RawItem): MappedCertainty {
  const status = item.status ?? "";

  if (NON_TERMINAL_STATUSES.has(status) || status === "") {
    return { status: null, terminal: false, certainty: null, email: null };
  }

  if (ERROR_STATUSES.has(status)) {
    return { status: null, terminal: true, certainty: null, email: null };
  }

  if (NOT_FOUND_STATUSES.has(status)) {
    return { status: "not_found", terminal: true, certainty: "not_found", email: null };
  }

  if (FOUND_STATUSES.has(status)) {
    const entry = item.results?.emails?.[0];
    const certainty = entry?.certainty ?? null;
    if (certainty && EMAIL_STATUSES.has(certainty)) {
      return { status: certainty, terminal: true, certainty, email: entry?.email ?? null };
    }
    // FOUND/DEBITED but no usable email/certainty in the results — treat the
    // same as NOT_FOUND rather than silently writing nothing.
    return { status: "not_found", terminal: true, certainty: certainty, email: null };
  }

  // Unrecognized status token — treat as non-terminal rather than guessing;
  // a caller polling in a loop will time out rather than write a bad value.
  return { status: null, terminal: false, certainty: null, email: null };
}

/** Throwing wrapper around mapCertainty for the ERROR_STATUSES case, used by
 * pollUntilTerminal/the webhook route so a BAD_INPUT/INSUFFICIENT_FUNDS/
 * ABORTED terminal item surfaces as a message instead of a silent null
 * status. */
function mapCertaintyOrThrow(item: RawItem, email: string): MappedCertainty {
  const mapped = mapCertainty(item);
  const status = item.status ?? "";
  if (ERROR_STATUSES.has(status)) {
    throw new Error(`Icypeas verification of ${email} ended in ${status}`);
  }
  return mapped;
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

export interface PollOptions {
  intervalMs?: number;
  timeoutMs?: number;
  deps?: VerifyDeps;
  /** The email being polled for, used only in error/timeout messages. */
  email?: string;
}

/** Poll `fetchResult(id)` on an interval until the item reaches a terminal
 * status, then map it to a VerifyResult. Used for local dev/testing (no
 * public webhook URL to receive Icypeas's callback) and as a safety net if a
 * webhook never arrives. Throws on timeout, on a fetch failure, or on an
 * error terminal status (BAD_INPUT/INSUFFICIENT_FUNDS/ABORTED). Mind the
 * read route's 30-calls/min rate limit (research doc §6) when running many
 * of these concurrently — see VERIFY_CONCURRENCY in lib/verify/reverify.ts. */
export async function pollUntilTerminal(
  id: string,
  { intervalMs = DEFAULT_POLL_INTERVAL_MS, timeoutMs = DEFAULT_POLL_TIMEOUT_MS, deps = {}, email = "" }: PollOptions = {}
): Promise<VerifyResult> {
  const deadline = Date.now() + timeoutMs;

  while (true) {
    const item = await fetchResult(id, deps);
    const mapped = mapCertaintyOrThrow(item, email);

    if (mapped.terminal) {
      if (!mapped.status) {
        // terminal but ERROR_STATUSES already throws above; this branch is
        // just defensive in case mapCertainty's terminal-without-status
        // contract is ever extended.
        throw new Error(`Icypeas verification of ${email} produced no result`);
      }
      return {
        email: mapped.email ?? email,
        status: mapped.status,
        certainty: mapped.certainty,
        credits: null,
      };
    }

    if (Date.now() >= deadline) {
      throw new Error(`Icypeas verification of ${email || id} timed out after ${timeoutMs}ms`);
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

// ---------------------------------------------------------------------------
// Webhook signature verification
// ---------------------------------------------------------------------------

/** Verify an inbound Icypeas webhook's HMAC-SHA1 signature (research doc
 * §2b). Optional — only meaningful when ICYPEAS_API_SECRET is configured;
 * the webhook route skips this entirely when no secret is set (MVP-ok per
 * the docs, which call this "an optional step").
 *
 * Algorithm (reconstructed from docs, not quoted verbatim — see research doc
 * §2b): payload = lowercase(endpointPath + timestamp), signature =
 * hex(HMAC-SHA1(apiSecret, payload)).
 * TODO: confirm the exact path+timestamp concatenation (delimiter, if any)
 * against a real webhook call before relying on this for anything other than
 * a best-effort check — the docs don't spell it out verbatim. */
export function verifyWebhookSignature(
  endpointPath: string,
  timestamp: string,
  signature: string,
  apiSecret: string
): boolean {
  if (!apiSecret || !signature || !timestamp) return false;
  const payload = `${endpointPath}${timestamp}`.toLowerCase();
  const expected = crypto.createHmac("sha1", apiSecret).update(payload).digest("hex");
  // Constant-time compare to avoid a timing side-channel; falls back to a
  // direct compare if the lengths differ (timingSafeEqual throws on mismatched
  // buffer lengths rather than just returning false).
  const expectedBuf = Buffer.from(expected, "hex");
  const signatureBuf = Buffer.from(signature, "hex");
  if (expectedBuf.length !== signatureBuf.length) return false;
  return crypto.timingSafeEqual(expectedBuf, signatureBuf);
}
