import "server-only";
import type { ClientRow } from "@/lib/data/clients";
import { GhlApiError, type GhlCredentials } from "@/lib/ghl/client";
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
  writeContactActivity,
  type ActivityQueueEntry,
  type PushedContact,
} from "@/lib/data/ghl-activity";

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
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

/** Walks `conversations/search` newest-first and queues every contact whose
 * activity may have moved. Returns the newest date seen and whether the pass
 * reached the end of the location.
 *
 * Stops at the first page that is entirely at or below `stopAtMs`. It checks
 * the page's OLDEST entry rather than bailing mid-page, so a page straddling
 * the mark is still processed in full — cheaper than being clever, and the
 * per-contact skip below catches anything redundant anyway. */
async function sweepConversations(
  credentials: GhlCredentials,
  pushedByGhlId: Map<string, PushedContact[]>,
  stopAtMs: number | null,
  deadline: number | undefined,
  fetchImpl: typeof fetch,
  onProgress: (() => void) | undefined
): Promise<{ pages: number; enqueued: ActivityQueueEntry[]; newestMs: number | null; reachedEnd: boolean }> {
  const enqueued: ActivityQueueEntry[] = [];
  const seenContactIds = new Set<string>();
  let cursor: number | null = null;
  let newestMs: number | null = null;
  let pages = 0;
  let reachedEnd = false;

  for (; pages < MAX_SWEEP_PAGES_PER_TICK; ) {
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
    if (stopAtMs != null && oldestMs != null && oldestMs <= stopAtMs) break;
    // No usable cursor value (every date null) — stop rather than loop on the
    // same page forever.
    if (oldestMs == null) break;
    cursor = oldestMs;

    if (deadline !== undefined && Date.now() >= deadline) break;
  }

  return { pages, enqueued, newestMs, reachedEnd };
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
    const message = err instanceof GhlApiError || err instanceof Error ? err.message : String(err);
    return { ok: false, error: message };
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

/** One tick of a client's activity sync.
 *
 * Phase order matters: the sweep runs only on a tick that finds an empty
 * queue, so a resumed job goes straight back to draining rather than
 * re-sweeping a location it already swept. */
export async function runGhlActivitySync(
  client: ClientRow,
  deps: RunGhlActivitySyncDeps = {}
): Promise<GhlActivitySyncResult> {
  if (!client.ghlApiKey || !client.ghlLocationId) {
    throw new Error(`Client "${client.name}" has no GHL credentials configured`);
  }

  const credentials: GhlCredentials = { apiKey: client.ghlApiKey, locationId: client.ghlLocationId };
  const fetchImpl = deps.fetchImpl ?? fetch;
  const onProgress = deps.onProgress;
  const deadline = deps.deadline;
  const offset = deps.offset ?? 0;

  const pushedByGhlId = await getPushedContactsByGhlId(client.id);

  let sweptPages = 0;
  let enqueuedCount = 0;

  const pending = await countActivityQueue(client.id);

  // Phase 1 — sweep (or, for a full refresh, queue everything directly).
  if (pending === 0) {
    if (deps.full) {
      const all: ActivityQueueEntry[] = Array.from(pushedByGhlId.keys()).map((ghlContactId) => ({
        ghlContactId,
        // No swept date: canSkipContact then always fetches, which is exactly
        // what "refresh, I don't trust the incremental path" means.
        lastMessageDate: null,
      }));
      await enqueueActivityContacts(client.id, all);
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
          deadline,
          fetchImpl,
          onProgress
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
      // deduped push can land on a conversation older than the mark).
      const cold: ActivityQueueEntry[] = [];
      const swept = new Set(sweep.enqueued.map((e) => e.ghlContactId));
      for (const [ghlContactId, rows] of pushedByGhlId) {
        if (swept.has(ghlContactId)) continue;
        if (rows.some((r) => r.activitySyncedAt == null)) {
          cold.push({ ghlContactId, lastMessageDate: null });
        }
      }

      const toEnqueue = [...sweep.enqueued, ...cold];
      if (toEnqueue.length > 0) await enqueueActivityContacts(client.id, toEnqueue);
      enqueuedCount = toEnqueue.length;

      await recordSweep(client.id, sweep.newestMs, sweep.reachedEnd);
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

  for (;;) {
    if (deadline !== undefined && Date.now() >= deadline) {
      hitDeadline = true;
      break;
    }

    const batch = await claimActivityQueueBatch(client.id, QUEUE_BATCH_SIZE);
    if (batch.length === 0) break;

    // Cheap skips first, so a steady-state run deletes most of its queue
    // without making a single API call.
    const settledIds: string[] = [];
    const toFetch: ActivityQueueEntry[] = [];
    for (const entry of batch) {
      if (canSkipContact(entry, pushedByGhlId.get(entry.ghlContactId))) {
        skipped++;
        settledIds.push(entry.ghlContactId);
      } else {
        toFetch.push(entry);
      }
    }

    for (const group of chunk(toFetch, GHL_ACTIVITY_CONCURRENCY)) {
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
        const personIds = entry ? (pushedByGhlId.get(entry.ghlContactId) ?? []).map((p) => p.personId) : [];

        if (settled.status === "fulfilled" && settled.value.result.ok) {
          fetched++;
          if (settled.value.result.changed) updated++;
          succeededPersonIds.push(...personIds);
          if (entry) settledIds.push(entry.ghlContactId);
        } else {
          errors++;
          const reason =
            settled.status === "fulfilled"
              ? (settled.value.result as { ok: false; error: string }).error
              : String((settled as PromiseRejectedResult).reason);
          failed.push({ name: entry?.ghlContactId ?? "unknown", reason });
          failedPersonIds.push(...personIds);
          // Dropped from the queue even on failure: leaving it would make a
          // single permanently-broken contact block the queue forever. The
          // next sweep re-queues it if its activity is still moving, and a
          // cold contact stays cold (activity_synced_at unwritten) so the
          // next run retries it anyway.
          if (entry) settledIds.push(entry.ghlContactId);
          console.error(
            `GHL activity sync: failed for contact ${entry?.ghlContactId ?? "unknown"} (client ${client.id}): ${reason}`
          );
        }
      }

      onProgress?.();

      if (deadline !== undefined && Date.now() >= deadline) {
        hitDeadline = true;
        break;
      }
    }

    if (settledIds.length > 0) await dequeueActivityContacts(client.id, settledIds);
    if (hitDeadline) break;
  }

  const remaining = await countActivityQueue(client.id);
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
    done: remaining === 0,
  };
}
