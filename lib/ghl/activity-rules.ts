/** The rules that turn a GHL message export into a "last activity" date.
 *
 * Pure functions, no I/O and no `server-only` — the exclusion rule and the
 * body sanitizer are the two pieces of this feature most worth testing in
 * isolation (a wrong exclusion rule silently shifts every date in the table),
 * and the relative-time formatter that renders the result lives client-side
 * in lib/format/relative-time.ts.
 *
 * Every rule here is settled research, not a guess — see
 * docs/features/ghl-last-activity/handoff.md §12 and §13. */

/** A message as `GET /conversations/messages/export` returns it. Field list
 * verified live against the Internal location (2026-09-30): id, contactId,
 * conversationId, direction, status, type, messageType, body, dateAdded,
 * dateUpdated, attachments, from, to, contentType, meta, altId, source,
 * userId. Only the fields we actually read are typed; the rest ride along in
 * `raw`. Note `dateAdded` comes back as an ISO string here, NOT the epoch-ms
 * the conversations endpoints use. */
export interface GhlExportedMessage {
  id: string;
  contactId?: string | null;
  conversationId?: string | null;
  direction?: string | null;
  messageType?: string | null;
  body?: string | null;
  dateAdded?: string | null;
}

/** GHL "messages" that the Contacts list does NOT count as Last activity.
 *
 * Verified in the UI (handoff §12.1): contact EAhzGidCP3m2hX7TX74S's only
 * conversation entry is a TYPE_ACTIVITY_APPOINTMENT and the UI renders Last
 * activity blank for it. A prefix match rather than a fixed set, because GHL
 * keeps adding TYPE_ACTIVITY_* variants (APPOINTMENT / CONTACT / OPPORTUNITY
 * are the ones seen live) and every one of them is a record of something the
 * CRM did, not of a message anyone sent. TYPE_SYSTEM_* is included on the
 * same reasoning. */
const EXCLUDED_MESSAGE_TYPE = /^TYPE_(NO_SHOW|ACTIVITY|SYSTEM)/;

/** True when a message counts toward last activity.
 *
 * A message with no `messageType` at all counts: the exclusion list is an
 * explicit deny-list of known non-messages, so an unrecognized shape errs
 * toward being real activity rather than silently blanking a contact's date.
 * Automated outbound counts too — that is a product decision, not an
 * oversight (handoff §12.3): "if we haven't reached out to someone even
 * automatically, that should be visible". Hence no direction test here. */
export function isActivityMessage(message: Pick<GhlExportedMessage, "messageType">): boolean {
  const type = message.messageType;
  if (!type) return true;
  return !EXCLUDED_MESSAGE_TYPE.test(type);
}

/** Maximum characters kept in `ghl_messages.body`. An HTML email body runs to
 * hundreds of KB; this column exists to render a readable preview in the
 * drawer, not to archive email. The untouched message stays in
 * `ghl_messages.raw`, which is what makes capping safe. */
export const MAX_BODY_CHARS = 4_000;

/** Strips HTML to readable text and caps the length.
 *
 * Deliberately a crude strip rather than a parser: the target is "readable in
 * a 24rem drawer", not faithful rendering. `<style>`/`<script>` contents are
 * dropped wholesale (an email's inlined CSS is otherwise the majority of the
 * text), block-ish tags become newlines so paragraphs survive, the five XML
 * entities plus `&nbsp;` are decoded, and runs of whitespace collapse.
 * Returns null for anything that reduces to nothing, so an empty body (calls
 * and no-shows carry none) stores as NULL rather than "". */
export function sanitizeMessageBody(body: string | null | undefined): string | null {
  if (!body) return null;

  const text = body
    .replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  if (text === "") return null;
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS - 1)}…` : text;
}

/** One message reduced to the columns `ghl_messages` stores. */
export interface NormalizedGhlMessage {
  ghlMessageId: string;
  conversationId: string | null;
  occurredAt: string;
  direction: string | null;
  messageType: string | null;
  body: string | null;
  raw: GhlExportedMessage;
}

/** The whole rule, applied to one contact's full export.
 *
 * Drops activity events and anything with an unparseable date, sorts newest
 * first, and reports the winner's date/type/direction. `lastActivityAt` is
 * null when nothing qualifies — which the table renders blank, matching the
 * GHL UI for an activity-only contact.
 *
 * The date is the MESSAGE's own dateAdded, never the conversation's
 * lastMessageDate: the latter is the conversation's update stamp and runs
 * about a second late (handoff §13.3). */
export interface ContactActivity {
  lastActivityAt: string | null;
  lastMessageType: string | null;
  lastMessageDirection: string | null;
  /** Newest first — the order the drawer renders. */
  messages: NormalizedGhlMessage[];
}

export function computeContactActivity(messages: GhlExportedMessage[]): ContactActivity {
  const normalized: NormalizedGhlMessage[] = [];

  for (const message of messages) {
    if (!message?.id) continue;
    if (!isActivityMessage(message)) continue;
    const occurredAtMs = message.dateAdded ? Date.parse(message.dateAdded) : NaN;
    if (Number.isNaN(occurredAtMs)) continue;
    normalized.push({
      ghlMessageId: message.id,
      conversationId: message.conversationId ?? null,
      occurredAt: new Date(occurredAtMs).toISOString(),
      direction: message.direction ?? null,
      messageType: message.messageType ?? null,
      body: sanitizeMessageBody(message.body),
      raw: message,
    });
  }

  normalized.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  const newest = normalized[0];
  return {
    lastActivityAt: newest?.occurredAt ?? null,
    lastMessageType: newest?.messageType ?? null,
    lastMessageDirection: newest?.direction ?? null,
    messages: normalized,
  };
}
