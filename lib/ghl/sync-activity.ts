import "server-only";
import type { ClientRow } from "@/lib/data/clients";
import type { GhlCredentials } from "@/lib/ghl/client";
import { errorMessage } from "@/lib/errors";
import {
  CONVERSATION_PAGE_SIZE,
  fetchContactMessages,
  fetchConversationPage,
  isScopeError,
} from "@/lib/ghl/conversations";
import { computeContactActivity } from "@/lib/ghl/activity-rules";
import {
  claimActivityQueueBatch,
  countActivityQueue,
  dequeueActivityContacts,
  enqueueActivityContacts,
  getPushedContactsByGhlId,
  getSweepState,
  recordSweep,
  reserveGhlApiCalls,
  writeContactActivity,
  type ActivityQueueEntry,
  type PushedContact,
} from "@/lib/data/ghl-activity";
import {
  INCREMENTAL_QUEUE_JOB_ID,
  isTargetedScope,
  queueJobIdFor,
  type ActivityScope,
} from "@/lib/ghl/activity-scope";
import { budgetDay, budgetStopReason, judgeBudget } from "@/lib/ghl/activity-budget";

/** Reads each pushed contact's GHL message history and recomputes their last
 * activity, as a resumable background job.
 *
 * Shaped like `runPeopleGhlPush` (lib/ghl/push-to-ghl.ts) on purpose — offset
 * cursor, wall-clock deadline, fixed concurrency, `Promise.allSettled` per
 * group, "a failure on one record never aborts the batch" — so the push
 * worker can dispatch it without learning a second set of conventions.
 *
 * ## The incremental strategy (the point of this file)
 *
 * The naive sync is one `messages/export` call per pushed contact, every run.
 * For 1,300 contacts that is 1,300 calls to discover that almost nothing
 * changed, and it scales with the size of our pushed set rather than with the
 * amount of new activity.
 *
 * Instead, a run has two phases:
 *
 *  **Sweep.** `GET /conversations/search?sortBy=last_message_date&sort=desc`
 *  returns 100 conversations per call, each carrying `contactId` and
 *  `lastMessageDate`, ordered newest-activity-first. One paged pass therefore
 *  tells us every contact whose activity has moved — ~305 calls for the
 *  Internal location's 30,481 conversations, versus one call per contact.
 *  Crucially, because the sort is by the very field we are watching, a
 *  conversation whose activity moved sorts to the top: the sweep can STOP the
 *  moment it pages below the previous run's high-water mark. Steady state is
 *  therefore one or two pages, not 305.
 *
 *  Paging is on `startAfterDate` (the previous page's oldest
 *  `lastMessageDate`). The `page` parameter is silently IGNORED by this
 *  endpoint — verified live, `page=2` returns page 1 — so using it would
 *  re-read the same 100 rows forever without erroring.
 *
 *  **Fetch.** Only contacts that survive three filters get an export call:
 *  they must have a `platform_contact_id` we pushed (the location holds
 *  30k conversations; we care about the ~1.3k we own), their swept
 *  `lastMessageDate` must be newer than their stored `last_activity_at`, and
 *  they must not already be at that value.
 *
 * Plus one correction: a **cold** contact (`activity_synced_at IS NULL`) is
 * always fetched directly, regardless of the sweep. A push that deduped onto
 * an existing GHL contact can land on a conversation far older than the
 * sweep's mark, which an incremental sweep will never revisit. Cold contacts
 * are a one-time cost per contact.
 *
 * Both phases write their work list to `ghl_activity_queue`, so the queue is
 * the cursor: a killed invocation resumes by draining what is left. */

/** Contacts fetched in parallel. GHL allows 100 requests / 10s per location
 * and each contact is exactly one export call, so 5 keeps a sync at roughly
 * half the burst ceiling — deliberately the same number as
 * GHL_PUSH_CONCURRENCY, because a sync and a push to the same client share
 * that one budget and may overlap. */
export const GHL_ACTIVITY_CONCURRENCY = 5;

/** Contacts pulled off the queue per round trip. Large enough that the queue
 * read isn't the bottleneck, small enough that a deadline hit wastes at most
 * this many contacts' worth of un-deleted queue rows (which are simply
 * re-processed, idempotently, next tick). */
const QUEUE_BATCH_SIZE = 50;

/** Hard ceiling on sweep pages in one tick, so a first full sweep of a very
 * large location can't eat the entire invocation budget before any contact is
 * fetched. 400 pages ≈ 40,000 conversations, past the largest location we
 * have seen (30,481). A sweep that hits this stops without marking the pass
 * complete, and resumes from its cursor next tick. */
const MAX_SWEEP_PAGES_PER_TICK = 400;

export interface GhlActivitySyncResult {
  /** Conversation pages read this tick. */
  sweptPages: number;
  /** Contacts the sweep added to the work queue this tick. */
  enqueued: number;
  /** Contacts whose messages were read this tick. */
  fetched: number;
  /** Of `fetched`, those whose `last_activity_at` actually changed. */
  updated: number;
  /** Contacts skipped because their stored value already matched the swept
   * date — the whole point of the optimisation, surfaced so it can be seen
   * working. */
  skipped: number;
  errors: number;
  failed: { name: string; reason: string }[];
  succeededPersonIds: string[];
  failedPersonIds: string[];
  /** Total contacts to process (queue depth + done this tick) — feeds the
   * job row's progress bar. */
  total: number;
  nextOffset: number;
  done: boolean;
  /** Set when the tick stopped for a reason that will still be true next tick
   * (today: the location's daily API budget). The caller must treat this as
   * terminal rather than self-chaining, or the worker spins on a job it cannot
   * advance until the UTC day rolls over. Null on a normal tick. */
  stoppedReason: string | null;
}

export interface RunGhlActivitySyncDeps {
  fetchImpl?: typeof fetch;
  onProgress?: () => void;
  /** Wall-clock epoch-ms deadline. Same contract as RunGhlPushDeps: stop
   * after the group in flight once passed, returning `done: false`. */
  deadline?: number;
  /** Count of contacts already processed by earlier ticks of this job, so the
   * returned `nextOffset` keeps climbing across a resumed run. Mirrors
   * RunGhlPushDeps.offset, though this core resumes from the durable queue
   * rather than by re-slicing a re-resolved list. */
  offset?: number;
  /** Skip the sweep and re-read every pushed contact directly. What the
   * manual "Refresh" button asks for when a user has reason to distrust the
   * incremental path. */
  full?: boolean;
  /** Which partition of `ghl_activity_queue` this run owns. A targeted job
   * passes its own job id; a whole-client run passes the all-zero sentinel and
   * shares the client's ongoing incremental queue. Defaults to the sentinel so
   * an existing caller keeps today's behaviour. */
  jobId?: string;
  /** What this run is allowed to look at (Decision 4). `{kind:"ids"}` turns on
   * targeted mode: no sweep, no sweep-state write, and the pushed set is read
   * narrowed to those people. `{kind:"queued"}` means the work list was
   * resolved from a filter at enqueue time and already sits in this job's
   * queue partition — same no-sweep rule, nothing to resolve. */
  scope?: ActivityScope;
  /** Skip contacts GHL positively told us it had just CREATED (Decision 5,
   * layer 1). Set by the post-push auto-sync: pushing 100k genuinely-new leads
   * otherwise queues 100k export calls for conversations that cannot exist
   * yet. See the cold-contact block below for why this narrows the COLD set
   * and not the sweep. */
  dedupedOnly?: boolean;
}

/** Attempts one contact gets inside a single run before it is dropped from the
 * queue and reported as failed.
 *
 * Two, not one: the failure this most often catches is a transient
 * `Timed out acquiring connection from connection pool` on the write-back
 * (handoff §14.5.8), which on a ten-person targeted refresh is the difference
 * between a clean result and a red row the user has to interpret. Two, not
 * unbounded: a permanently-broken contact must never block its job's queue,
 * which is the property the original drop-on-failure behaviour was protecting.
 *
 * The counter is in memory and per-run on purpose — there is no attempts
 * column, and adding one would buy very little: a run that genuinely cannot
 * read a contact should surface that to the user now, not grind at it across
 * ticks. */
const MAX_CONTACT_ATTEMPTS = 2;

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/** Walks `conversations/search` newest-first and queues every contact whose
 * activity may have moved. Returns the newest date seen, whether the pass
 * reached the end of the location, and where to resume if it didn't.
 *
 * Stops at the first page that is entirely at or below `stopAtMs`. It checks
 * the page's OLDEST entry rather than bailing mid-page, so a page straddling
 * the mark is still processed in full — cheaper than being clever, and the
 * per-contact skip below catches anything redundant anyway.
 *
 * `startCursor` resumes an unfinished sweep. A first full sweep of a large
 * location is ~305 sequential calls and will not fit in one worker tick, so
 * without resumption every tick would re-read the same opening pages, the
 * pass would never reach the end, and early stopping would never switch on. */
async function sweepConversations(
  credentials: GhlCredentials,
  pushedByGhlId: Map<string, PushedContact[]>,
  stopAtMs: number | null,
  startCursor: number | null,
  deadline: number | undefined,
  fetchImpl: typeof fetch,
  onProgress: (() => void) | undefined,
  /** Reserves budget for the page about to be read; false means the location
   * is out of quota and the pass must stop where it is. Reserved per page
   * rather than up front for the whole pass, because a steady-state sweep is
   * one or two pages and reserving MAX_SWEEP_PAGES_PER_TICK would burn 400
   * calls of quota in order to spend two. */
  reserve: (calls: number) => Promise<boolean>
): Promise<{
  pages: number;
  enqueued: ActivityQueueEntry[];
  newestMs: number | null;
  reachedEnd: boolean;
  nextCursor: number | null;
}> {
  const enqueued: ActivityQueueEntry[] = [];
  const seenContactIds = new Set<string>();
  let cursor: number | null = startCursor;
  let newestMs: number | null = null;
  let pages = 0;
  let reachedEnd = false;
  // A pass can finish for three different reasons, and only one of them wants
  // a resume cursor:
  //   reachedEnd  — walked to the oldest conversation. Pass complete.
  //   caughtUp    — paged below the previous run's mark, so every later page is
  //                 already recorded. Complete FOR ITS PURPOSE: the next sweep
  //                 must start from the newest again, not resume here.
  //   neither     — ran out of tick budget (or page cap). THIS is the one that
  //                 must resume, or a first full sweep never reaches the end.
  let caughtUp = false;

  for (; pages < MAX_SWEEP_PAGES_PER_TICK; ) {
    // Out of quota: stop exactly as a tick-budget exhaustion would — the pass
    // keeps its resume cursor and the next run picks it up from there.
    if (!(await reserve(1))) break;
    const page = await fetchConversationPage(credentials, cursor, { fetchImpl });
    pages++;
    onProgress?.();

    if (page.conversations.length === 0) {
      reachedEnd = true;
      break;
    }

    let oldestMs: number | null = null;
    for (const conv of page.conversations) {
      const ms = conv.lastMessageDate;
      if (ms != null) {
        if (newestMs == null || ms > newestMs) newestMs = ms;
        if (oldestMs == null || ms < oldestMs) oldestMs = ms;
      }
      // Only contacts we pushed are worth an export call — the location holds
      // every contact the client has ever had.
      if (!conv.contactId || !pushedByGhlId.has(conv.contactId)) continue;
      if (seenContactIds.has(conv.contactId)) continue;
      seenContactIds.add(conv.contactId);
      enqueued.push({
        ghlContactId: conv.contactId,
        lastMessageDate: ms != null ? new Date(ms).toISOString() : null,
      });
    }

    // Fewer than a full page back means we've reached the oldest conversation.
    if (page.conversations.length < CONVERSATION_PAGE_SIZE) {
      reachedEnd = true;
      break;
    }
    // Everything on this page is at or below the previous run's mark, so every
    // later page is too — that is the early stop the whole design turns on.
    if (stopAtMs != null && oldestMs != null && oldestMs <= stopAtMs) {
      caughtUp = true;
      break;
    }
    // No usable cursor value (every date null) — stop rather than loop on the
    // same page forever. Treated as caught-up so we don't persist a cursor
    // that would resume onto the very page we just failed to advance past.
    if (oldestMs == null) {
      caughtUp = true;
      break;
    }
    cursor = oldestMs;

    if (deadline !== undefined && Date.now() >= deadline) break;
  }

  // Only an interrupted pass hands back a resume point; a pass that reached
  // the end or caught up with the mark clears it so the next sweep starts
  // from the newest conversation again.
  return {
    pages,
    enqueued,
    newestMs,
    reachedEnd,
    nextCursor: reachedEnd || caughtUp ? null : cursor,
  };
}

/** Reads one contact's full history and writes it. Returns whether the stored
 * date actually moved, so the caller can report how much work was real. */
async function syncOneContact(
  entry: ActivityQueueEntry,
  client: ClientRow,
  credentials: GhlCredentials,
  fetchImpl: typeof fetch,
  pushed: PushedContact[]
): Promise<{ ok: true; changed: boolean } | { ok: false; error: string }> {
  try {
    const messages = await fetchContactMessages(credentials, entry.ghlContactId, { fetchImpl });
    const activity = computeContactActivity(messages);

    const previous = pushed[0]?.lastActivityAt ?? null;
    await writeContactActivity({
      clientId: client.id,
      ghlContactId: entry.ghlContactId,
      personIds: pushed.map((p) => p.personId),
      lastActivityAt: activity.lastActivityAt,
      lastMessageType: activity.lastMessageType,
      lastMessageDirection: activity.lastMessageDirection,
      messages: activity.messages,
    });

    return { ok: true, changed: previous !== activity.lastActivityAt };
  } catch (err) {
    // errorMessage, not String(err): the write-back path throws supabase-js's
    // bare {message, code} object, which String()s to "[object Object]" and
    // hid a real connection-pool failure behind a reason that named nothing.
    return { ok: false, error: errorMessage(err) };
  }
}

/** True when the swept date tells us nothing new — the stored value already
 * matches (to the second) what GHL reports, and this contact has been synced
 * before so its history is already on file.
 *
 * Compared with a one-second tolerance because the sweep's
 * `lastMessageDate` is the CONVERSATION's update stamp, which runs ~1s later
 * than the message's own `dateAdded` that we store (handoff §13.3). Comparing
 * them for equality would mark every contact as changed, forever, and quietly
 * turn the incremental sync back into a full one. */
export function canSkipContact(
  entry: ActivityQueueEntry,
  pushed: PushedContact[] | undefined
): boolean {
  if (!pushed || pushed.length === 0) return true; // not ours (any more) — nothing to write
  if (pushed.some((p) => p.activitySyncedAt == null)) return false; // cold: always fetch once
  if (!entry.lastMessageDate) return false;

  const sweptMs = Date.parse(entry.lastMessageDate);
  if (Number.isNaN(sweptMs)) return false;

  return pushed.every((p) => {
    if (!p.lastActivityAt) return false;
    const storedMs = Date.parse(p.lastActivityAt);
    if (Number.isNaN(storedMs)) return false;
    // Stored can legitimately trail the swept value by up to ~1s; anything
    // beyond that (in either direction) is real movement.
    return Math.abs(sweptMs - storedMs) <= 1_500;
  });
}

/** Whether this contact could possibly have messages worth an export call
 * (Decision 5, layer 1).
 *
 * `platform_pushes.was_deduped` records GHL's own `new` flag from the upsert
 * that wrote the row: false means GHL created the contact fresh, so it has no
 * conversation and reading it is a guaranteed-empty API call. A push of 100k
 * genuinely-new leads auto-enqueues a sync; without this, that sync makes
 * ~100k export calls — about 3.5 hours and half the location's daily quota —
 * to discover 100k empty inboxes.
 *
 * THREE states, and only one of them is a skip:
 *   true  — GHL matched an existing contact. Read it.
 *   null  — unknown. Every row pushed before this column existed is NULL, as
 *           is a response whose `new` flag we couldn't recognize. Read it.
 *           Treating NULL as "new" would silently drop the entire existing
 *           corpus from every post-push sync, forever, with no error — which
 *           is why this is `!== false` and never `=== true`.
 *   false — GHL created it seconds ago. Skip.
 *
 * A contact is skipped only when EVERY push row for it says false: if two of
 * our people share one GHL contact and either push matched an existing
 * contact, the conversation exists. */
export function mayHaveMessages(pushed: PushedContact[] | undefined): boolean {
  if (!pushed || pushed.length === 0) return false;
  return pushed.some((p) => p.wasDeduped !== false);
}

/** One tick of a client's activity sync.
 *
 * Phase order matters: the sweep runs only on a tick that finds an empty
 * queue, so a resumed job goes straight back to draining rather than
 * re-sweeping a location it already swept.
 *
 * ## Targeted mode (Decision 3)
 *
 * When `scope` names person ids, the sweep is skipped ENTIRELY and
 * `ghl_activity_sweeps` is never written. The sweep exists to DISCOVER which
 * contacts moved; a caller that names the contacts has done that discovery
 * already, and a cold sweep costs ~138s against the Internal location —
 * absurd overhead on a thirty-contact refresh. The sweep-state write is the
 * part that actually matters: `recordSweep` has exactly one call site, inside
 * the non-targeted branch below, so a targeted run leaves
 * `last_message_date_ms`, `full_sweep_completed_at` and `sweep_cursor_ms`
 * untouched and the next incremental run behaves as if it never happened.
 * Keep it that way — a targeted run has not walked the location and must
 * never be allowed to advance a mark that claims it has. */
export async function runGhlActivitySync(
  client: ClientRow,
  deps: RunGhlActivitySyncDeps = {}
): Promise<GhlActivitySyncResult> {
  if (!client.ghlApiKey || !client.ghlLocationId) {
    throw new Error(`Client "${client.name}" has no GHL credentials configured`);
  }

  const locationId = client.ghlLocationId;
  const credentials: GhlCredentials = { apiKey: client.ghlApiKey, locationId };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const onProgress = deps.onProgress;
  const deadline = deps.deadline;
  const offset = deps.offset ?? 0;

  const scope = deps.scope;
  const targeted = isTargetedScope(scope);
  // Its work list was resolved from a filter at enqueue time and written
  // straight into this job's partition, so phase 1 has nothing left to do:
  // no sweep (same reason as targeted mode — the discovery is done), and no
  // re-enqueue, because the rows ARE the scope. An empty partition here means
  // the job has drained, not that it should go and find more work.
  const preQueued = scope?.kind === "queued";
  // A job that resolved its own work list — targeted, pre-queued, or a full
  // re-read — owns a private partition of the queue; only a plain incremental
  // run joins the shared one, whose rows persist across runs and ARE its
  // resume cursor. `deps.full` is part of that test: a full re-read writes the
  // client's entire pushed set and never sweeps, so leaving it in the shared
  // partition let an abandoned full job's work be silently drained (and paid
  // for) by the next incremental sync, which then skipped its own sweep.
  const queueJobId = queueJobIdFor(deps.jobId ?? INCREMENTAL_QUEUE_JOB_ID, scope, deps.full === true);

  // -- The per-location daily budget (Decision 5, layer 2) -------------------
  // Every GHL call this tick makes passes through `reserve` first. The RPC
  // increments and returns the new total in one statement, so two workers
  // racing for the last of the quota cannot both see room; the ceiling itself
  // is app-side policy, deliberately not baked into the schema.
  const day = budgetDay();
  let budgetStop: string | null = null;
  const reserve = async (calls: number): Promise<boolean> => {
    if (budgetStop) return false;
    const total = await reserveGhlApiCalls(locationId, calls, day);
    if (total == null) return true; // guard not installed yet — logged in the data layer
    const verdict = judgeBudget(total);
    if (!verdict.allowed) {
      budgetStop = budgetStopReason(locationId, day, verdict.used);
      return false;
    }
    return true;
  };

  // Targeted mode reads only the selected people's push rows. The whole-client
  // read loads the client's entire pushed set (thousands of rows) on every
  // tick, which a ten-person refresh pays for and uses almost none of.
  //
  // A pre-queued job falls on the whole-client side because its scope names
  // contacts, not people: this map is how a queue row finds the person ids to
  // write back to, and narrowing it would need the person ids the job
  // deliberately does not carry.
  const pushedByGhlId = await getPushedContactsByGhlId(
    client.id,
    targeted ? { personIds: scope.personIds } : {}
  );

  let sweptPages = 0;
  let enqueuedCount = 0;

  const pending = await countActivityQueue(client.id, queueJobId);

  // Phase 1 — resolve the work list. Four shapes: pre-queued (already
  // resolved), targeted (no sweep), full (everything, no sweep), incremental
  // (sweep).
  if (pending === 0) {
    if (preQueued) {
      // Nothing to resolve and, above all, nothing to sweep.
    } else if (targeted) {
      // The caller named these people; the only resolution left is "which GHL
      // contact is each of them". No swept date, so canSkipContact always
      // fetches — which is what a user watching these specific rows asked for.
      const all: ActivityQueueEntry[] = Array.from(pushedByGhlId.keys()).map((ghlContactId) => ({
        ghlContactId,
        lastMessageDate: null,
      }));
      if (all.length > 0) await enqueueActivityContacts(client.id, queueJobId, all);
      enqueuedCount = all.length;
    } else if (deps.full) {
      const all: ActivityQueueEntry[] = Array.from(pushedByGhlId.keys()).map((ghlContactId) => ({
        ghlContactId,
        // No swept date: canSkipContact then always fetches, which is exactly
        // what "refresh, I don't trust the incremental path" means.
        lastMessageDate: null,
      }));
      await enqueueActivityContacts(client.id, queueJobId, all);
      enqueuedCount = all.length;
    } else {
      const state = await getSweepState(client.id);
      // Before the first end-to-end pass there is no mark below which
      // "nothing changed" is safe, so the first sweep runs to the end.
      const stopAtMs = state.fullSweepCompletedAt ? state.lastMessageDateMs : null;

      let sweep;
      try {
        sweep = await sweepConversations(
          credentials,
          pushedByGhlId,
          stopAtMs,
          state.sweepCursorMs,
          deadline,
          fetchImpl,
          onProgress,
          reserve
        );
      } catch (err) {
        // A stale/contacts-only token 401s on every conversations endpoint
        // (handoff §11.1). That is one client's credentials problem, not a
        // reason to kill a job, so it surfaces as a clear terminal error the
        // worker records against this job.
        if (isScopeError(err)) {
          throw new Error(
            `Client "${client.name}" has a GHL token without the conversations scope — ` +
              `re-issue its Private Integration token before syncing last activity.`
          );
        }
        throw err;
      }

      sweptPages = sweep.pages;
      // Cold contacts: never synced, so the sweep may never surface them (a
      // deduped push can land on a conversation older than the mark). Queued
      // on every pass, including a partial one — the queue upserts on
      // (client, job, contact), so re-adding one already queued is a no-op, and
      // a contact the later pages would have surfaced anyway is simply
      // processed once by whichever path reached it first.
      //
      // `dedupedOnly` prunes THIS set and only this set (Decision 5, layer 1).
      // The cold set is where the 100k-push blow-up lives: 100k freshly
      // created contacts are all cold, and each would cost one export call to
      // learn it has no conversation. The SWEEP is deliberately left
      // unnarrowed — it is discovery, it costs the same one or two pages
      // either way, and a brand-new contact that genuinely did receive a reply
      // shows up in it and is fetched. Narrowing the sweep too would be the
      // difference between "don't pay for data that cannot exist" and "never
      // look at these contacts again".
      const cold: ActivityQueueEntry[] = [];
      const swept = new Set(sweep.enqueued.map((e) => e.ghlContactId));
      for (const [ghlContactId, rows] of pushedByGhlId) {
        if (swept.has(ghlContactId)) continue;
        if (!rows.some((r) => r.activitySyncedAt == null)) continue;
        if (deps.dedupedOnly && !mayHaveMessages(rows)) continue;
        cold.push({ ghlContactId, lastMessageDate: null });
      }

      const toEnqueue = [...sweep.enqueued, ...cold];
      if (toEnqueue.length > 0) await enqueueActivityContacts(client.id, queueJobId, toEnqueue);
      enqueuedCount = toEnqueue.length;

      // The ONLY recordSweep call site, and it must stay that way: a targeted
      // run has not walked the location and must not advance a mark that says
      // it has. The mark only moves forward, so a resumed pass (whose pages are
      // older than the mark by definition) can't drag it backwards.
      await recordSweep(client.id, sweep.newestMs, sweep.reachedEnd, sweep.nextCursor);
    }
  }

  // Phase 2 — drain the queue.
  let fetched = 0;
  let updated = 0;
  let skipped = 0;
  let errors = 0;
  const failed: { name: string; reason: string }[] = [];
  const succeededPersonIds: string[] = [];
  const failedPersonIds: string[] = [];
  let hitDeadline = false;

  /** Attempts spent per contact within this run — see MAX_CONTACT_ATTEMPTS. */
  const attempts = new Map<string, number>();

  for (;;) {
    if (budgetStop) break;
    if (deadline !== undefined && Date.now() >= deadline) {
      hitDeadline = true;
      break;
    }

    const batch = await claimActivityQueueBatch(client.id, queueJobId, QUEUE_BATCH_SIZE);
    if (batch.length === 0) break;

    // Cheap skips first, so a steady-state run deletes most of its queue
    // without making a single API call.
    const settledIds: string[] = [];
    let toFetch: ActivityQueueEntry[] = [];
    for (const entry of batch) {
      if (canSkipContact(entry, pushedByGhlId.get(entry.ghlContactId))) {
        skipped++;
        settledIds.push(entry.ghlContactId);
      } else {
        toFetch.push(entry);
      }
    }

    // One pass per attempt: a contact that fails is retried once within this
    // batch before being settled as failed, so a transient write-back blip
    // doesn't surface as a red row on a refresh the user is watching.
    for (let attempt = 1; attempt <= MAX_CONTACT_ATTEMPTS && toFetch.length > 0; attempt++) {
      const retry: ActivityQueueEntry[] = [];

      for (const group of chunk(toFetch, GHL_ACTIVITY_CONCURRENCY)) {
        // One export call per contact (a contact with a genuinely long history
        // pages, which under-reserves slightly — the safe direction is covered
        // by the 50k of headroom the ceiling leaves under GHL's own limit).
        if (!(await reserve(group.length))) break;

        const results = await Promise.allSettled(
          group.map(async (entry) => ({
            entry,
            result: await syncOneContact(
              entry,
              client,
              credentials,
              fetchImpl,
              pushedByGhlId.get(entry.ghlContactId) ?? []
            ),
          }))
        );

        for (const settled of results) {
          const entry = settled.status === "fulfilled" ? settled.value.entry : null;
          const pushed = entry ? (pushedByGhlId.get(entry.ghlContactId) ?? []) : [];
          const personIds = pushed.map((p) => p.personId);

          if (settled.status === "fulfilled" && settled.value.result.ok) {
            fetched++;
            if (settled.value.result.changed) updated++;
            succeededPersonIds.push(...personIds);
            if (entry) settledIds.push(entry.ghlContactId);
            continue;
          }

          const reason =
            settled.status === "fulfilled"
              ? (settled.value.result as { ok: false; error: string }).error
              : errorMessage((settled as PromiseRejectedResult).reason);

          // A rejected promise carries no entry, so there is nothing to retry
          // or settle — count it and move on, as before.
          if (!entry) {
            errors++;
            failed.push({ name: "unknown", reason });
            console.error(`GHL activity sync: failed for an unknown contact (client ${client.id}): ${reason}`);
            continue;
          }

          const spent = (attempts.get(entry.ghlContactId) ?? 0) + 1;
          attempts.set(entry.ghlContactId, spent);
          if (spent < MAX_CONTACT_ATTEMPTS) {
            retry.push(entry);
            continue;
          }

          errors++;
          // Named by person id, not GHL contact id: on a targeted refresh the
          // user selected PEOPLE, and "contact mN3k…" in the failures list is
          // not something they can match back to a row.
          failed.push({ name: personIds[0] ?? entry.ghlContactId, reason });
          failedPersonIds.push(...personIds);
          // Still dropped from the queue after its last attempt: leaving it
          // would make one permanently-broken contact block this job's queue
          // forever, which is the property the original behaviour protected.
          // It is NOT dropped silently — the reason and the person ids go onto
          // the job row, so the Push Activity panel shows the job as
          // partial/failed with a per-person reason, and a cold contact stays
          // cold (activity_synced_at unwritten) so the next run retries it.
          settledIds.push(entry.ghlContactId);
          console.error(
            `GHL activity sync: failed for contact ${entry.ghlContactId} (client ${client.id}): ${reason}`
          );
        }

        onProgress?.();

        if (deadline !== undefined && Date.now() >= deadline) {
          hitDeadline = true;
          break;
        }
      }

      if (hitDeadline || budgetStop) break;
      toFetch = retry;
    }

    if (settledIds.length > 0) await dequeueActivityContacts(client.id, queueJobId, settledIds);
    if (hitDeadline || budgetStop) break;
  }

  const remaining = await countActivityQueue(client.id, queueJobId);
  const processed = fetched + skipped + errors;

  return {
    sweptPages,
    enqueued: enqueuedCount,
    fetched,
    updated,
    skipped,
    errors,
    failed,
    succeededPersonIds,
    failedPersonIds,
    total: offset + processed + remaining,
    nextOffset: offset + processed,
    // A budget stop leaves work behind by definition, so `done` stays honest
    // and `stoppedReason` tells the caller not to self-chain on it.
    done: remaining === 0,
    stoppedReason: budgetStop,
  };
}
