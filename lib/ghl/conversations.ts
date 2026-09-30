import "server-only";
import {
  GhlApiError,
  requestGetWithRetry,
  type GhlClientDeps,
  type GhlCredentials,
} from "@/lib/ghl/client";
import type { GhlExportedMessage } from "@/lib/ghl/activity-rules";

/** The two conversations endpoints the last-activity sync reads.
 *
 * Both go through `requestGetWithRetry` (lib/ghl/client.ts) so they inherit
 * the same 429/5xx handling, Retry-After parsing and jittered backoff the
 * push path already uses — GHL's limits are per location, so a sync running
 * alongside a push shares one budget and must back off the same way. */

/** How many conversations one sweep page asks for. 100 is the endpoint's own
 * maximum; anything smaller just multiplies the number of calls needed to
 * cross a 30k-conversation location. */
export const CONVERSATION_PAGE_SIZE = 100;

/** How many messages one export call asks for. Verified live: a single call
 * returns a contact's complete history (the probe's contacts all came back
 * with `nextCursor: null`), so this is a safety ceiling rather than a page
 * size — `fetchContactMessages` follows `nextCursor` anyway for the contact
 * with a genuinely long history. */
export const MESSAGE_EXPORT_LIMIT = 200;

/** Safety stop on cursor-following, in case a malformed `nextCursor` ever
 * points back at itself. 50 pages × 200 = 10,000 messages for one contact,
 * far past anything real. */
const MAX_EXPORT_PAGES = 50;

/** One conversation as `GET /conversations/search` returns it. Only the four
 * fields the sweep reads are typed. */
export interface GhlConversationSummary {
  id: string;
  contactId: string | null;
  /** Epoch ms — this endpoint's dates are numbers, unlike the export
   * endpoint's ISO strings. */
  lastMessageDate: number | null;
  lastMessageType: string | null;
}

export interface ConversationSweepPage {
  conversations: GhlConversationSummary[];
  /** Total conversations in the location, as reported by GHL. Only useful for
   * logging/progress — it is the unfiltered total, not a remaining count. */
  total: number;
}

/** True for a 401 that means "this token lacks the conversations scope".
 *
 * Known live state (handoff §11.1): three client rows share the Internal
 * location and one of them (`testing`) still holds a stale contacts-only
 * token that 401s on every conversations endpoint. That is a credentials
 * problem for one client, not a reason to crash a job that may be syncing
 * several — so the sync catches this specifically and fails that client with
 * a message a human can act on. */
export function isScopeError(err: unknown): boolean {
  return err instanceof GhlApiError && err.status === 401;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** One page of the location's conversations, newest activity first.
 *
 * CRITICAL: this endpoint IGNORES `page`. Paging is done by passing the
 * previous page's oldest `lastMessageDate` as `startAfterDate`; passing
 * `page=2` silently re-returns page 1 (confirmed live — the first id was
 * identical). Getting this wrong doesn't error, it just re-reads the same 100
 * rows forever.
 *
 * `startAfterDate` is exclusive-ish in practice but not documented as such,
 * so the caller de-duplicates by conversation id rather than trusting it. */
export async function fetchConversationPage(
  credentials: GhlCredentials,
  startAfterDate: number | null,
  deps: GhlClientDeps = {}
): Promise<ConversationSweepPage> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const params = new URLSearchParams({
    locationId: credentials.locationId,
    limit: String(CONVERSATION_PAGE_SIZE),
    sortBy: "last_message_date",
    sort: "desc",
  });
  if (startAfterDate != null) params.set("startAfterDate", String(startAfterDate));

  const { status, json } = await requestGetWithRetry(
    fetchImpl,
    credentials,
    `/conversations/search?${params.toString()}`
  );
  if (status < 200 || status >= 300) {
    throw new GhlApiError(`GHL conversations/search failed with status ${status}`, status);
  }

  const record = (json ?? {}) as Record<string, unknown>;
  const raw = Array.isArray(record.conversations) ? record.conversations : [];
  const conversations: GhlConversationSummary[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const conv = entry as Record<string, unknown>;
    if (typeof conv.id !== "string") continue;
    conversations.push({
      id: conv.id,
      contactId: typeof conv.contactId === "string" ? conv.contactId : null,
      lastMessageDate: asNumber(conv.lastMessageDate),
      lastMessageType: typeof conv.lastMessageType === "string" ? conv.lastMessageType : null,
    });
  }

  return { conversations, total: asNumber(record.total) ?? 0 };
}

/** One contact's complete message history.
 *
 * `GET /conversations/messages/export` is the only endpoint that returns a
 * contact's messages across every conversation and channel in one call, which
 * is why the feature uses it rather than the per-conversation endpoint: one
 * call yields both the last-activity date and the history the drawer renders
 * (handoff §13.4). Returns [] when the contact has no messages at all — a
 * brand-new pushed contact, which renders blank. */
export async function fetchContactMessages(
  credentials: GhlCredentials,
  contactId: string,
  deps: GhlClientDeps = {}
): Promise<GhlExportedMessage[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const messages: GhlExportedMessage[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < MAX_EXPORT_PAGES; page++) {
    const params = new URLSearchParams({
      locationId: credentials.locationId,
      contactId,
      limit: String(MESSAGE_EXPORT_LIMIT),
    });
    if (cursor) params.set("cursor", cursor);

    const { status, json } = await requestGetWithRetry(
      fetchImpl,
      credentials,
      `/conversations/messages/export?${params.toString()}`
    );
    if (status < 200 || status >= 300) {
      throw new GhlApiError(
        `GHL messages export failed for contact ${contactId} with status ${status}`,
        status
      );
    }

    const record = (json ?? {}) as Record<string, unknown>;
    const batch = Array.isArray(record.messages) ? record.messages : [];
    for (const entry of batch) {
      if (entry && typeof entry === "object") messages.push(entry as GhlExportedMessage);
    }

    const next = record.nextCursor;
    if (typeof next !== "string" || next === "" || next === cursor || batch.length === 0) break;
    cursor = next;
  }

  return messages;
}
