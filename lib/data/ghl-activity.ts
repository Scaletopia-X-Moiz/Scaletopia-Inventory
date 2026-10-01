import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/data/fetch-all-rows";
import { mapWithConcurrency } from "@/lib/concurrency";
import type { NormalizedGhlMessage } from "@/lib/ghl/activity-rules";
import type { LastActivityFilter } from "@/lib/data/last-activity-filter";
import { INCREMENTAL_QUEUE_JOB_ID } from "@/lib/ghl/activity-scope";
import { budgetDay } from "@/lib/ghl/activity-budget";

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
  /** Where an unfinished sweep stopped (a `startAfterDate` value), or null for
   * "start from the newest". A first full sweep of a large location does not
   * fit in one worker tick, so it must resume rather than restart — otherwise
   * it can never reach the end and early stopping never switches on. */
  sweepCursorMs: number | null;
}

export async function getSweepState(clientId: string): Promise<SweepState> {
  const { data, error } = await supabaseAdmin
    .from("ghl_activity_sweeps")
    .select("last_message_date_ms,full_sweep_completed_at,sweep_cursor_ms")
    .eq("client_id", clientId)
    .maybeSingle();
  if (error) throw error;
  return {
    lastMessageDateMs: (data?.last_message_date_ms as number | null) ?? null,
    fullSweepCompletedAt: (data?.full_sweep_completed_at as string | null) ?? null,
    sweepCursorMs: (data?.sweep_cursor_ms as number | null) ?? null,
  };
}

/** Advances the mark after a sweep. `fullSweep` records that this run reached
 * the end of the location, which is what unlocks early stopping for every
 * later run. The mark only ever moves forward: a sweep that found nothing
 * newer leaves it alone rather than resetting it — which is also what makes a
 * RESUMED sweep safe, since its pages are older than the mark by definition.
 *
 * `nextCursorMs` is where an unfinished sweep stopped; a finished one passes
 * null, clearing it so the next sweep starts from the newest again. */
export async function recordSweep(
  clientId: string,
  newestMessageDateMs: number | null,
  fullSweep: boolean,
  nextCursorMs: number | null = null
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
      sweep_cursor_ms: nextCursorMs,
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

/** Adds contacts to one job's work list. Upsert on the composite PK so a
 * sweep that re-sees a contact (or a second sweep before the first drained)
 * refreshes its observed date instead of conflicting. Chunked because a first
 * full sweep can enqueue tens of thousands of rows in one go.
 *
 * EVERY queue operation in this file takes a `jobId` and filters on it. The
 * queue used to be keyed `(client_id, ghl_contact_id)` alone, and because the
 * sync only enqueues when the queue is empty, two jobs for one client shared
 * one work list: a targeted job could drain rows another job had queued and
 * then report success while the other job reported nothing to do. The all-zero
 * sentinel (INCREMENTAL_QUEUE_JOB_ID) is the shared incremental partition;
 * a targeted job writes under its own id. */
export async function enqueueActivityContacts(
  clientId: string,
  jobId: string,
  entries: ActivityQueueEntry[]
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < entries.length; i += CHUNK) {
    const { error } = await supabaseAdmin.from("ghl_activity_queue").upsert(
      entries.slice(i, i + CHUNK).map((e) => ({
        client_id: clientId,
        job_id: jobId,
        ghl_contact_id: e.ghlContactId,
        last_message_date: e.lastMessageDate,
      })),
      { onConflict: "client_id,job_id,ghl_contact_id" }
    );
    if (error) throw error;
  }
}

/** Oldest-first batch of pending work for this client. Ordered by
 * `enqueued_at` so a resumed job drains in a stable order and the cold-contact
 * entries a sweep appended last are processed last. */
export async function claimActivityQueueBatch(
  clientId: string,
  jobId: string,
  limit: number
): Promise<ActivityQueueEntry[]> {
  const { data, error } = await supabaseAdmin
    .from("ghl_activity_queue")
    .select("ghl_contact_id,last_message_date")
    .eq("client_id", clientId)
    .eq("job_id", jobId)
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
export async function dequeueActivityContacts(
  clientId: string,
  jobId: string,
  ghlContactIds: string[]
): Promise<void> {
  const CHUNK = 200;
  for (let i = 0; i < ghlContactIds.length; i += CHUNK) {
    const { error } = await supabaseAdmin
      .from("ghl_activity_queue")
      .delete()
      .eq("client_id", clientId)
      .eq("job_id", jobId)
      .in("ghl_contact_id", ghlContactIds.slice(i, i + CHUNK));
    if (error) throw error;
  }
}

export async function countActivityQueue(clientId: string, jobId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("ghl_activity_queue")
    .select("ghl_contact_id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .eq("job_id", jobId);
  if (error) throw error;
  return count ?? 0;
}

/** Drops a targeted job's entire partition.
 *
 * Only ever called for a NON-sentinel job_id, and only once that job has
 * reached a terminal state: a targeted job re-resolves its contact set from
 * the person ids stored in `push_jobs.options` on every run, so its leftover
 * queue rows carry no information once the job is over — whereas the shared
 * incremental partition's rows ARE the resume cursor and must never be
 * cleared this way. */
export async function clearActivityQueueForJob(clientId: string, jobId: string): Promise<void> {
  if (jobId === INCREMENTAL_QUEUE_JOB_ID) return;
  const { error } = await supabaseAdmin
    .from("ghl_activity_queue")
    .delete()
    .eq("client_id", clientId)
    .eq("job_id", jobId);
  if (error) throw error;
}

// -- platform_pushes: the contacts we actually care about --------------------

export interface PushedContact {
  personId: string;
  ghlContactId: string;
  lastActivityAt: string | null;
  activitySyncedAt: string | null;
  /** True when GHL's upsert matched an EXISTING contact, false when it created
   * a fresh one, null when we don't know (every row pushed before the column
   * existed, plus the rare response with no recognizable `new` flag).
   *
   * Only `false` is actionable: a contact GHL created seconds ago cannot have
   * a conversation, so reading its messages is a guaranteed-empty API call.
   * Null must be treated as "might have messages" — see dedupedOnly below. */
  wasDeduped: boolean | null;
}

/** How many person ids go into one PostgREST `in.(...)` list. The filter
 * travels in the query string, and 2,000 uuids is ~74 KB of URL — well past
 * what any proxy will carry. */
const ID_FILTER_CHUNK = 200;

/** How many of those chunked lookups may be in flight at once.
 *
 * A filtered refresh can carry MAX_FILTERED_PEOPLE ids, which is ~125 chunks;
 * `Promise.all` over all of them opens ~125 concurrent Supabase queries, and
 * each chunk is itself a `fetchAllRows` (a count plus its pages). This project
 * already sees pool timeouts under far less, and the preview runs this on
 * every click in the refresh dialog. Six at a time keeps the chunks
 * overlapping without the fan-out scaling with the user's selection. */
const ID_FILTER_CONCURRENCY = 6;

export interface PushedContactQuery {
  /** Narrow to these people only. The whole-client read loads the client's
   * entire pushed set (thousands of rows) on EVERY tick, which is pure waste
   * for a targeted refresh of ten people. */
  personIds?: string[];
}

/** Note on `was_deduped`: it is deliberately selected and returned rather than
 * filtered on here. The "skip contacts GHL just created" rule (Decision 5,
 * layer 1) is applied in memory by `mayHaveMessages` (lib/ghl/sync-activity.ts)
 * because it must distinguish three states, and a three-valued column is the
 * easiest thing in the world to get wrong in a PostgREST filter: `= true`
 * drops every pre-existing row (they are all NULL) and `NOT was_deduped` is
 * NULL-unsafe. In memory the three cases are explicit and unit-testable. */

/** Every person this client has a GHL contact id for. The sweep intersects
 * against this: a location holds every contact the client has ever had, but
 * only the ones we pushed have a person to hang a date on.
 *
 * Keyed by GHL contact id, and deliberately a Map of ARRAYS: `platform_contact_id`
 * is not unique, because GHL dedupes on phone, so two of our people can end up
 * pointing at the same GHL contact. Both must receive the date. */
export async function getPushedContactsByGhlId(
  clientId: string,
  query: PushedContactQuery = {}
): Promise<Map<string, PushedContact[]>> {
  const COLUMNS = "id,person_id,platform_contact_id,last_activity_at,activity_synced_at,was_deduped";
  type Row = {
    person_id: string;
    platform_contact_id: string | null;
    last_activity_at: string | null;
    activity_synced_at: string | null;
    was_deduped: boolean | null;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const applyCommon = (q: any, ids?: string[]) => {
    const out = q.eq("client_id", clientId).eq("platform", PLATFORM).not("platform_contact_id", "is", null);
    return ids ? out.in("person_id", ids) : out;
  };

  let rows: Row[];
  if (query.personIds) {
    const ids = Array.from(new Set(query.personIds));
    if (ids.length === 0) return new Map();
    const chunks: string[][] = [];
    for (let i = 0; i < ids.length; i += ID_FILTER_CHUNK) chunks.push(ids.slice(i, i + ID_FILTER_CHUNK));
    const pages = await mapWithConcurrency(chunks, ID_FILTER_CONCURRENCY, (part) =>
      fetchAllRows<Row>("platform_pushes", COLUMNS, (q) => applyCommon(q, part))
    );
    rows = pages.flat();
  } else {
    rows = await fetchAllRows<Row>("platform_pushes", COLUMNS, (q) => applyCommon(q));
  }

  const byGhlId = new Map<string, PushedContact[]>();
  for (const row of rows) {
    if (!row.platform_contact_id) continue;
    const entry: PushedContact = {
      personId: row.person_id,
      ghlContactId: row.platform_contact_id,
      lastActivityAt: row.last_activity_at,
      activitySyncedAt: row.activity_synced_at,
      wasDeduped: row.was_deduped ?? null,
    };
    const existing = byGhlId.get(row.platform_contact_id);
    if (existing) existing.push(entry);
    else byGhlId.set(row.platform_contact_id, [entry]);
  }
  return byGhlId;
}

/** Which sub-accounts a selection of people actually touches, and how many of
 * them each one holds.
 *
 * The fan-out endpoint's whole job (Decision 1) is "refresh these people
 * everywhere they were pushed", and `platform_pushes` is the only record of
 * where that is. Returns nothing for a person who has never been pushed to
 * GHL — which is an informational outcome for the caller, not an error. */
export interface ClientForPeople {
  clientId: string;
  personCount: number;
  personIds: string[];
  /** The GHL contacts those people map to in this sub-account. Distinct, and
   * can be fewer than `personCount`: GHL dedupes on phone, so two of our
   * people can share one contact — which is also why this is the honest basis
   * for "how many API calls will this cost". */
  ghlContactIds: string[];
}

export async function getClientsForPeople(personIds: string[]): Promise<ClientForPeople[]> {
  const ids = Array.from(new Set(personIds.filter((id) => id && id.trim() !== "")));
  if (ids.length === 0) return [];

  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_FILTER_CHUNK) chunks.push(ids.slice(i, i + ID_FILTER_CHUNK));

  const pages = await mapWithConcurrency(chunks, ID_FILTER_CONCURRENCY, (part) =>
    fetchAllRows<{ client_id: string; person_id: string; platform_contact_id: string | null }>(
      "platform_pushes",
      "id,client_id,person_id,platform_contact_id",
      (query) =>
        query.eq("platform", PLATFORM).not("platform_contact_id", "is", null).in("person_id", part)
    )
  );

  // Counted as DISTINCT people per client: a person can hold several rows for
  // one client over time, and reporting "3 people" for one person pushed three
  // times would be a number the user can't reconcile with their selection.
  const byClient = new Map<string, { people: Set<string>; contacts: Set<string> }>();
  for (const row of pages.flat()) {
    let entry = byClient.get(row.client_id);
    if (!entry) {
      entry = { people: new Set(), contacts: new Set() };
      byClient.set(row.client_id, entry);
    }
    entry.people.add(row.person_id);
    if (row.platform_contact_id) entry.contacts.add(row.platform_contact_id);
  }

  return Array.from(byClient, ([clientId, { people, contacts }]) => ({
    clientId,
    personCount: people.size,
    personIds: Array.from(people),
    ghlContactIds: Array.from(contacts),
  })).sort((a, b) => b.personCount - a.personCount);
}

/** How many people this sub-account has a GHL contact for.
 *
 * The honest size of a WHOLE-sub-account refresh, which names no people and
 * so has no id set to count. A head count rather than a fetch because the
 * number is only ever shown, never iterated; it reads as an upper bound on
 * the API calls such a refresh can cost, since two people sharing one GHL
 * contact are read once. */
export async function countPushedPeople(clientId: string): Promise<number> {
  const { count, error } = await supabaseAdmin
    .from("platform_pushes")
    .select("id", { count: "exact", head: true })
    .eq("client_id", clientId)
    .eq("platform", PLATFORM)
    .not("platform_contact_id", "is", null);
  if (error) throw error;
  return count ?? 0;
}

// -- The per-location daily API budget ---------------------------------------

/** Reserves `calls` against a location's daily quota and returns the new
 * total (Decision 5, layer 2).
 *
 * A RESERVATION, not an accounting entry: it must be called BEFORE the calls
 * are spent. Recording afterwards would let every concurrent worker read the
 * same comfortable number, all decide there is room, and all spend on top of
 * it. Reservations are never refunded — a call that 429'd still consumed
 * quota, and over-counting is the safe direction.
 *
 * Keyed on LOCATION rather than client because co-located client rows share
 * one real GHL quota (three of ours share `MeFEd7scikKpI44Utr8N`).
 *
 * Best-effort by design: if the RPC isn't there yet (PGRST202 — the schema is
 * applied separately from the deploy) the guard degrades to "no ceiling"
 * rather than failing every activity job on an unrelated migration gap. That
 * is logged loudly, because a silent un-guarded sync is exactly what this
 * layer exists to prevent. */
export async function reserveGhlApiCalls(
  ghlLocationId: string,
  calls: number,
  day: string = budgetDay()
): Promise<number | null> {
  if (calls <= 0) return null;
  const { data, error } = await supabaseAdmin.rpc("increment_ghl_api_budget", {
    p_location_id: ghlLocationId,
    p_calls: calls,
    p_day: day,
  });
  if (error) {
    if (error.code === "PGRST202") {
      console.error(
        `[ghl-activity] increment_ghl_api_budget is missing — the daily API budget guard is NOT active ` +
          `(location ${ghlLocationId}). Apply lib/data/*.sql.`
      );
      return null;
    }
    throw error;
  }
  return typeof data === "number" ? data : null;
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
 * first, and both people still get the date. Storing it twice would double the
 * table for no benefit the date column doesn't already give.
 *
 * KNOWN LIMITATION, stated rather than implied: the second person's drawer is
 * then empty. `getPersonGhlMessages` reads by `person_id` and has no
 * conversation-level fallback — an earlier version of this comment claimed it
 * did, which was simply untrue.
 *
 * The conflict key is `(ghl_message_id, client_id)`, not `ghl_message_id`
 * alone. Two client rows sharing one GHL location see byte-identical message
 * ids, and a global key made the second client's upsert overwrite the first
 * client's `person_id`/`client_id` — last writer wins, and a person's drawer
 * silently went blank.
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
        { onConflict: "ghl_message_id,client_id" }
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

export interface PersonGhlPush {
  clientId: string;
  clientName: string | null;
  /** Null for a person pushed to this sub-account whose contact has never had
   * a qualifying message — which is a different answer from "never pushed",
   * and the person detail page renders them differently. */
  lastActivityAt: string | null;
  lastMessageType: string | null;
  lastMessageDirection: string | null;
  /** When the sync last read this contact. Null means the activity sync has
   * never looked, so "no activity yet" is an unverified claim. */
  activitySyncedAt: string | null;
  pushedAt: string | null;
}

/** Every sub-account one person was pushed to, with that sub-account's OWN
 * last-activity stamp — newest first.
 *
 * Deliberately NOT getPeopleLastActivity: that one collapses to a max across
 * clients, because the People table has no current client and needs one date
 * per row. The person detail page is the place where "which sub-account was
 * this person last active in" has to be answerable, and a max destroys exactly
 * that. It also returns rows with a null `last_activity_at`, which the table's
 * read filters out: "pushed to this sub-account, nothing has happened" is the
 * answer the detail page's empty state is built on.
 *
 * Rows with no `platform_contact_id` are excluded — the push never landed a
 * contact, so there is no GHL side to report activity for. */
export async function getPersonGhlPushes(personId: string): Promise<PersonGhlPush[]> {
  const { data, error } = await supabaseAdmin
    .from("platform_pushes")
    .select(
      "client_id,last_activity_at,last_message_type,last_message_direction,activity_synced_at,pushed_at,client:clients(name)"
    )
    .eq("person_id", personId)
    .eq("platform", PLATFORM)
    .not("platform_contact_id", "is", null);
  if (error) throw error;

  return ((data ?? []) as unknown as {
    client_id: string;
    last_activity_at: string | null;
    last_message_type: string | null;
    last_message_direction: string | null;
    activity_synced_at: string | null;
    pushed_at: string | null;
    client: { name: string | null } | null;
  }[])
    .map((row) => ({
      clientId: row.client_id,
      clientName: row.client?.name ?? null,
      lastActivityAt: row.last_activity_at,
      lastMessageType: row.last_message_type,
      lastMessageDirection: row.last_message_direction,
      activitySyncedAt: row.activity_synced_at,
      pushedAt: row.pushed_at,
    }))
    // Sub-accounts with activity first, newest first; the never-active ones
    // keep a stable alphabetical order behind them rather than whatever order
    // PostgREST happened to return.
    .sort((a, b) => {
      if (a.lastActivityAt && b.lastActivityAt) return b.lastActivityAt.localeCompare(a.lastActivityAt);
      if (a.lastActivityAt) return -1;
      if (b.lastActivityAt) return 1;
      return (a.clientName ?? "").localeCompare(b.clientName ?? "");
    });
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
