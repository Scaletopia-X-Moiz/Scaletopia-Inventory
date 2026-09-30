import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/data/fetch-all-rows";
import type { NormalizedGhlMessage } from "@/lib/ghl/activity-rules";
import type { LastActivityFilter } from "@/lib/data/last-activity-filter";

/** Data layer for the GHL last-activity feature (schema in
 * lib/data/ghl-activity.sql): the sweep high-water mark, the durable work
 * queue, the message-history writes, and the two reads the UI does (the
 * People table's column and the drawer's history). */

const PLATFORM = "ghl";

// -- Sweep high-water mark ---------------------------------------------------

export interface SweepState {
  /** Newest `lastMessageDate` (epoch ms) the last completed sweep saw. A
   * later sweep can stop the moment it pages below this. Null before the
   * first sweep. */
  lastMessageDateMs: number | null;
  /** Set once the location has been walked end-to-end at least once. Until
   * then the mark is not trustworthy as a stopping point, because there is
   * no "everything older than this is already recorded" guarantee. */
  fullSweepCompletedAt: string | null;
}

export async function getSweepState(clientId: string): Promise<SweepState> {
  const { data, error } = await supabaseAdmin
    .from("ghl_activity_sweeps")
    .select("last_message_date_ms,full_sweep_completed_at")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  return {
    lastMessageDateMs: (data?.last_message_date_ms as number | null) ?? null,
    fullSweepCompletedAt: (data?.full_sweep_completed_at as string | null) ?? null,
  };
}

/** Advances the mark after a sweep. `fullSweep` records that this run reached
 * the end of the location, which is what unlocks early stopping for every
 * later run. The mark only ever moves forward: a sweep that found nothing
 * newer leaves it alone rather than resetting it. */
export async function recordSweep(
  clientId: string,
  newestMessageDateMs: number | null,
  fullSweep: boolean
): Promise<void> {
  const current = await getSweepState(clientId);
  const nextMark =
    newestMessageDateMs != null && (current.lastMessageDateMs == null || newestMessageDateMs > current.lastMessageDateMs)
      ? newestMessageDateMs
      : current.lastMessageDateMs;

  const { error } = await supabaseAdmin.from("ghl_activity_sweeps").upsert(
    {
      client_id: clientId,
      last_message_date_ms: nextMark,
      full_sweep_completed_at: fullSweep ? new Date().toISOString() : current.fullSweepCompletedAt,
      last_swept_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "client_id" }
  );
  if (error) throw error;
}

// -- Work queue --------------------------------------------------------------

export interface ActivityQueueEntry {
  ghlContactId: string;
  lastMessageDate: string | null;
}

/** Adds contacts to this client's work list. Upsert on the composite PK so a
 * sweep that re-sees a contact (or a second sweep before the first drained)
 * refreshes its observed date instead of conflicting. Chunked because a first
 * full sweep can enqueue tens of thousands of rows in one go. */
export async function enqueueActivityContacts(
  clientId: string,
  entries: ActivityQueueEntry[]
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const { error } = await supabaseAdmin.from("ghl_activity_queue").upsert(
      entries.slice(i, i + CHUNK).map((e) => ({
        client_id: clientId,
        ghl_contact_id: e.ghlContactId,
        last_message_date: e.lastMessageDate,
      })),
      { onConflict: "client_id,ghl_contact_id" }
    );
    if (error) throw error;
  }
}

/** Oldest-first batch of pending work for this client. Ordered by
 * `enqueued_at` so a resumed job drains in a stable order and the cold-contact
 * entries a sweep appended last are processed last. */
export async function claimActivityQueueBatch(
  clientId: string,
  limit: number
): Promise<ActivityQueueEntry[]> {
  const { data, error } = await supabaseAdmin
    .from("ghl_activity_queue")
    .select("ghl_contact_id,last_message_date")
    .eq("client_id", clientId)
    .order("enqueued_at", { ascending: true })
    .order("ghl_contact_id", { ascending: true })
    .limit(limit);
  if (error) throw error;
  return ((data ?? []) as { ghl_contact_id: string; last_message_date: string | null }[]).map((row) => ({
    ghlContactId: row.ghl_contact_id,
    lastMessageDate: row.last_message_date,
  }));
}

/** Removes finished work. Called after each batch, so an invocation killed
 * mid-job leaves exactly the un-processed remainder behind — the queue IS the
 * cursor, which is why nothing about the fetch phase needs offset arithmetic. */
export async function dequeueActivityContacts(clientId: string, ghlContactIds: string[]): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < ghlContactIds.length; i += CHUNK) {
    const { error } = await supabaseAdmin
      .from("ghl_activity_queue")
      .delete()
      .eq("client_id", clientId)
      .in("ghl_contact_id", ghlContactIds.slice(i, i + CHUNK));
    if (error) throw error;
  }
}

export async function countActivityQueue(clientId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("ghl_activity_queue")
    .select("ghl_contact_id", { count: "exact", head: true })
    .eq("client_id", clientId);
  if (error) throw error;
  return count ?? 0;
}

// -- platform_pushes: the contacts we actually care about --------------------

export interface PushedContact {
  personId: string;
  ghlContactId: string;
  lastActivityAt: string | null;
  activitySyncedAt: string | null;
}

/** Every person this client has a GHL contact id for. The sweep intersects
 * against this: a location holds every contact the client has ever had, but
 * only the ones we pushed have a person to hang a date on.
 *
 * Keyed by GHL contact id, and deliberately a Map of ARRAYS: `platform_contact_id`
 * is not unique, because GHL dedupes on phone, so two of our people can end up
 * pointing at the same GHL contact. Both must receive the date. */
export async function getPushedContactsByGhlId(clientId: string): Promise<Map<string, PushedContact[]>> {
  const rows = await fetchAllRows<{
    person_id: string;
    platform_contact_id: string | null;
    last_activity_at: string | null;
    activity_synced_at: string | null;
  }>(
    "platform_pushes",
    "id,person_id,platform_contact_id,last_activity_at,activity_synced_at",
    (query) => query.eq("client_id", clientId).eq("platform", PLATFORM).not("platform_contact_id", "is", null)
  );

  const byGhlId = new Map<string, PushedContact[]>();
  for (const row of rows) {
    if (!row.platform_contact_id) continue;
    const entry: PushedContact = {
      personId: row.person_id,
      ghlContactId: row.platform_contact_id,
      lastActivityAt: row.last_activity_at,
      activitySyncedAt: row.activity_synced_at,
    };
    const existing = byGhlId.get(row.platform_contact_id);
    if (existing) existing.push(entry);
    else byGhlId.set(row.platform_contact_id, [entry]);
  }
  return byGhlId;
}

// -- Writes ------------------------------------------------------------------

export interface ContactActivityWrite {
  clientId: string;
  ghlContactId: string;
  personIds: string[];
  lastActivityAt: string | null;
  lastMessageType: string | null;
  lastMessageDirection: string | null;
  messages: NormalizedGhlMessage[];
}

/** Persists one contact's sync: the message rows, then the denormalized date
 * on every platform_pushes row that points at this GHL contact.
 *
 * Messages upsert on `ghl_message_id`, so re-syncing a contact (which always
 * re-reads the full export — the endpoint has no incremental mode) rewrites
 * the same rows rather than duplicating them. `person_id` is part of the row
 * but not of the conflict key: if the same GHL contact backs two of our
 * people, the message is stored once, against whichever person the write saw
 * first, and both people still get the date. Storing it twice would need a
 * composite key and would double the table for no display benefit — the
 * drawer falls back to reading by conversation when a person has no rows of
 * its own (see getPersonGhlMessages).
 *
 * `activity_synced_at` is stamped even when nothing qualified, so a contact
 * with genuinely no messages stops being "cold" and is never re-fetched
 * directly again. */
export async function writeContactActivity(write: ContactActivityWrite): Promise<void> {
  const primaryPersonId = write.personIds[0];
  if (!primaryPersonId) return;

  if (write.messages.length > 0) {
    const CHUNK = 200;
    for (let i = 0; i < write.messages.length; i += CHUNK) {
      const { error } = await supabaseAdmin.from("ghl_messages").upsert(
        write.messages.slice(i, i + CHUNK).map((m) => ({
          person_id: primaryPersonId,
          client_id: write.clientId,
          ghl_message_id: m.ghlMessageId,
          conversation_id: m.conversationId,
          occurred_at: m.occurredAt,
          direction: m.direction,
          message_type: m.messageType,
          body: m.body,
          raw: m.raw as unknown as Record<string, unknown>,
        })),
        { onConflict: "ghl_message_id" }
      );
      if (error) throw error;
    }
  }

  const { error: pushError } = await supabaseAdmin
    .from("platform_pushes")
    .update({
      last_activity_at: write.lastActivityAt,
      last_message_type: write.lastMessageType,
      last_message_direction: write.lastMessageDirection,
      activity_synced_at: new Date().toISOString(),
    })
    .eq("client_id", write.clientId)
    .eq("platform", PLATFORM)
    .eq("platform_contact_id", write.ghlContactId);
  if (pushError) throw pushError;
}

// -- Reads for the UI --------------------------------------------------------

/** The People table's "Last activity" column, for one page of rows.
 *
 * Scoped to the page's ids exactly like getPersonEnrichmentValues, so the
 * column costs one small indexed query per rendered page and nothing at all
 * on the list query itself — which is what keeps the no-filter path's timing
 * unchanged.
 *
 * A person can be pushed to several clients, and the People table has no
 * "current client", so the column shows the MOST RECENT activity across every
 * client that person was pushed to. That is the honest answer to "when did
 * anything last happen with this lead"; the filter, which does have a client,
 * is per-client. */
export async function getPeopleLastActivity(personIds: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (personIds.length === 0) return result;

  const { data, error } = await supabaseAdmin
    .from("platform_pushes")
    .select("person_id,last_activity_at")
    .eq("platform", PLATFORM)
    .in("person_id", personIds)
    .not("last_activity_at", "is", null);
  if (error) throw error;

  for (const row of (data ?? []) as { person_id: string; last_activity_at: string }[]) {
    const current = result.get(row.person_id);
    if (!current || row.last_activity_at > current) result.set(row.person_id, row.last_activity_at);
  }
  return result;
}

export interface GhlMessageRow {
  id: string;
  clientId: string;
  clientName: string | null;
  conversationId: string | null;
  occurredAt: string;
  direction: string | null;
  messageType: string | null;
  body: string | null;
}

/** The drawer's history: every message we have stored for one person, newest
 * first, across every client they were pushed to.
 *
 * Read from OUR database, never live from GHL — the drawer opens on a click
 * in a table where a user may open a dozen rows in a row, and a live call per
 * open would both add a second of latency and burn the location's rate
 * budget. Freshness comes from the sync/refresh path instead. */
export async function getPersonGhlMessages(personId: string, limit = 200): Promise<GhlMessageRow[]> {
  const { data, error } = await supabaseAdmin
    .from("ghl_messages")
    .select("id,client_id,conversation_id,occurred_at,direction,message_type,body,client:clients(name)")
    .eq("person_id", personId)
    .order("occurred_at", { ascending: false })
    .limit(limit);
  if (error) throw error;

  return ((data ?? []) as unknown as {
    id: string;
    client_id: string;
    conversation_id: string | null;
    occurred_at: string;
    direction: string | null;
    message_type: string | null;
    body: string | null;
    client: { name: string | null } | null;
  }[]).map((row) => ({
    id: row.id,
    clientId: row.client_id,
    clientName: row.client?.name ?? null,
    conversationId: row.conversation_id,
    occurredAt: row.occurred_at,
    direction: row.direction,
    messageType: row.message_type,
    body: row.body,
  }));
}

// -- The filter's id set -----------------------------------------------------

/** The person ids an active last-activity filter narrows to, or null when the
 * filter is inactive — the same "null means no-op" contract
 * resolveVirtualFilterIds and resolvePushJobIds use in lib/data/people.ts.
 *
 * Resolved straight off `platform_pushes` through PostgREST, with NO change to
 * the six filter RPCs. Two reasons, both load-bearing:
 *
 *  1. lib/data/ticket-25-esp-filter.sql:23-31 records that adding a dimension
 *     to people_matching_virtual_filters cost a ~60x regression on the
 *     no-filter call before it was rewritten to hashed id sets, and that the
 *     id-set form then TIMED OUT inside person_push_status_counts. Every one
 *     of those functions is a single query whose plan the new predicate can
 *     perturb. Not touching them is worth more than facet precision.
 *  2. The id set here is bounded by the *pushed* population for one client
 *     (thousands), not by `people` (136k), so it is small enough for the
 *     existing restricted-ids machinery to intersect in app code — exactly
 *     what the pushJobId filter already does.
 *
 * Consequence, and it is a real one: facet counts in the filter slip are not
 * scoped by an active last-activity filter, the same way they are already not
 * scoped by pushJobId. Documented in the handoff.
 *
 * Semantics: every operator is scoped to people pushed to that client, so
 * "is empty" means "pushed to this client and nothing has happened", not
 * "everyone in the database including the 135k we never pushed". That is both
 * the question the retargeting use case asks and what keeps the id set small.
 */
export async function resolveLastActivityIds(
  filter: LastActivityFilter | undefined
): Promise<string[] | null> {
  if (!filter) return null;

  const rows = await fetchAllRows<{ person_id: string }>(
    "platform_pushes",
    "id,person_id",
    (query) => {
      let q = query.eq("client_id", filter.clientId).eq("platform", PLATFORM);
      switch (filter.op) {
        case "empty":
          q = q.is("last_activity_at", null);
          break;
        case "not_empty":
          q = q.not("last_activity_at", "is", null);
          break;
        case "between":
          if (filter.from) q = q.gte("last_activity_at", filter.from);
          if (filter.to) q = q.lte("last_activity_at", filter.to);
          q = q.not("last_activity_at", "is", null);
          break;
        case "within_days": {
          const since = new Date(Date.now() - filter.days * 24 * 60 * 60 * 1000).toISOString();
          q = q.gte("last_activity_at", since);
          break;
        }
      }
      return q;
    }
  );

  return Array.from(new Set(rows.map((row) => row.person_id)));
}
