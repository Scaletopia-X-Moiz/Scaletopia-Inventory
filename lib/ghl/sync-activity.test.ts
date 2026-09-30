import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { canSkipContact, runGhlActivitySync } from "@/lib/ghl/sync-activity";
import { CONVERSATION_PAGE_SIZE } from "@/lib/ghl/conversations";
import { getSweepState } from "@/lib/data/ghl-activity";
import type { ClientRow } from "@/lib/data/clients";

/** The incremental sync's two load-bearing behaviors: the skip logic that
 * makes it incremental at all, and the sweep/queue/deadline mechanics that
 * make it resumable across worker ticks.
 *
 * GHL is stubbed via `fetchImpl` (the same seam lib/ghl/push-to-ghl.test.ts
 * uses); Supabase is real, matching this repo's convention of testing the data
 * layer against the live schema rather than mocking it. */

const TEST_PREFIX = "__test-ghl-activity__";

async function cleanupAll() {
  const [{ data: people }, { data: clients }] = await Promise.all([
    supabaseAdmin.from("people").select("id").like("linkedin_url", `%${TEST_PREFIX}%`),
    supabaseAdmin.from("clients").select("id").like("slug", `${TEST_PREFIX}%`),
  ]);
  const personIds = (people ?? []).map((p) => p.id as string);
  const clientIds = (clients ?? []).map((c) => c.id as string);

  // ghl_messages cascades from people, but platform_pushes has plain FKs to
  // both, so its rows must go first — same ordering push-to-ghl.test.ts uses.
  if (personIds.length > 0) {
    await supabaseAdmin.from("ghl_messages").delete().in("person_id", personIds);
    await supabaseAdmin.from("platform_pushes").delete().in("person_id", personIds);
  }
  if (clientIds.length > 0) {
    await supabaseAdmin.from("ghl_activity_queue").delete().in("client_id", clientIds);
    await supabaseAdmin.from("ghl_activity_sweeps").delete().in("client_id", clientIds);
    await supabaseAdmin.from("platform_pushes").delete().in("client_id", clientIds);
  }
  await supabaseAdmin.from("people").delete().like("linkedin_url", `%${TEST_PREFIX}%`);
  await supabaseAdmin.from("clients").delete().like("slug", `${TEST_PREFIX}%`);
}

/** These hooks each run several queries against the live 136k-row `people`
 * table, which comfortably exceeds vitest's 10s default hook timeout whenever
 * the project is under any other load. Matches the generous testTimeout
 * vitest.config.ts already sets for the same reason. */
const HOOK_TIMEOUT_MS = 60_000;

let client: ClientRow;

/** `n` people, each already "pushed" to the test client with a distinct GHL
 * contact id — the state the sync reads as its working set. */
async function seedPushedPeople(n: number): Promise<{ personId: string; ghlContactId: string }[]> {
  const { data: people, error } = await supabaseAdmin
    .from("people")
    .insert(
      Array.from({ length: n }, (_, i) => ({
        full_name: `${TEST_PREFIX}person-${i}`,
        linkedin_url: `https://linkedin.com/in/${TEST_PREFIX}${i}-${Date.now()}`,
      }))
    )
    .select("id");
  if (error) throw error;

  const rows = (people ?? []).map((p, i) => ({
    personId: p.id as string,
    ghlContactId: `${TEST_PREFIX}contact-${i}`,
  }));

  const { error: pushError } = await supabaseAdmin.from("platform_pushes").insert(
    rows.map((r) => ({
      person_id: r.personId,
      client_id: client.id,
      platform: "ghl",
      platform_contact_id: r.ghlContactId,
    }))
  );
  if (pushError) throw pushError;
  return rows;
}

/** A fetch stub over the two GHL endpoints the sync calls. `conversations` is
 * returned as a single page; a contact's export returns one SMS whose
 * `dateAdded` is, by default, that contact's own conversation date — which is
 * what a real location looks like, and what the skip logic is written against.
 * `messageDateFor` overrides it (return null for a contact whose export comes
 * back empty). Records every URL so call counts can be asserted — the whole
 * point of the optimisation is how few of these there are. */
function stubGhl(options: {
  conversations: { contactId: string; lastMessageDate: number }[];
  messageDateFor?: (contactId: string) => string | null;
}): { fetchImpl: typeof fetch; calls: string[] } {
  const conversationDate = new Map(
    options.conversations.map((c) => [c.contactId, new Date(c.lastMessageDate).toISOString()])
  );
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);

    if (url.includes("/conversations/search")) {
      // Only the first page has content; the second comes back empty, which
      // the sweep reads as "reached the end of the location".
      const isFirstPage = !url.includes("startAfterDate");
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          conversations: isFirstPage
            ? options.conversations.map((c, i) => ({
                id: `conv-${i}`,
                contactId: c.contactId,
                lastMessageDate: c.lastMessageDate,
                lastMessageType: "TYPE_SMS",
              }))
            : [],
          total: options.conversations.length,
        }),
      } as unknown as Response;
    }

    if (url.includes("/conversations/messages/export")) {
      const contactId = new URL(url).searchParams.get("contactId") ?? "";
      const dateAdded = options.messageDateFor
        ? options.messageDateFor(contactId)
        : (conversationDate.get(contactId) ?? "2026-09-20T10:00:00.000Z");
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({
          messages: dateAdded
            ? [
                {
                  id: `msg-${contactId}`,
                  contactId,
                  conversationId: `conv-${contactId}`,
                  direction: "inbound",
                  messageType: "TYPE_SMS",
                  body: "hello",
                  dateAdded,
                },
              ]
            : [],
          nextCursor: null,
          total: dateAdded ? 1 : 0,
        }),
      } as unknown as Response;
    }

    throw new Error(`unexpected URL in stub: ${url}`);
  }) as unknown as typeof fetch;

  return { fetchImpl, calls };
}

const exportCalls = (calls: string[]) => calls.filter((c) => c.includes("/messages/export")).length;
const sweepCalls = (calls: string[]) => calls.filter((c) => c.includes("/conversations/search")).length;

beforeAll(async () => {
  await cleanupAll();
  const { data, error } = await supabaseAdmin
    .from("clients")
    .insert({
      slug: `${TEST_PREFIX}${Date.now()}`,
      name: "GHL Activity Test Client",
      ghl_api_key: "test-key-not-a-real-token",
      ghl_location_id: "test-location",
      is_active: true,
    })
    .select("id,slug,name,ghl_api_key,ghl_location_id,emailbison_api_key,emailbison_workspace_id,is_active,updated_at")
    .single();
  if (error) throw error;
  client = {
    id: data.id as string,
    slug: data.slug as string,
    name: data.name as string,
    ghlApiKey: data.ghl_api_key as string,
    ghlLocationId: data.ghl_location_id as string,
    emailbisonApiKey: null,
    emailbisonWorkspaceId: null,
    isActive: true,
    updatedAt: data.updated_at as string,
  };
}, HOOK_TIMEOUT_MS);

afterAll(cleanupAll, HOOK_TIMEOUT_MS);

beforeEach(async () => {
  // Between cases, reset everything except the client row itself.
  const { data: people } = await supabaseAdmin
    .from("people")
    .select("id")
    .like("linkedin_url", `%${TEST_PREFIX}%`);
  const personIds = (people ?? []).map((p) => p.id as string);
  if (personIds.length > 0) {
    await supabaseAdmin.from("ghl_messages").delete().in("person_id", personIds);
    await supabaseAdmin.from("platform_pushes").delete().in("person_id", personIds);
    await supabaseAdmin.from("people").delete().in("id", personIds);
  }
  await supabaseAdmin.from("ghl_activity_queue").delete().eq("client_id", client.id);
  await supabaseAdmin.from("ghl_activity_sweeps").delete().eq("client_id", client.id);
}, HOOK_TIMEOUT_MS);

describe("canSkipContact — the incremental skip", () => {
  const synced = (lastActivityAt: string | null) => [
    {
      personId: "p1",
      ghlContactId: "c1",
      lastActivityAt,
      activitySyncedAt: "2026-09-01T00:00:00.000Z",
    },
  ];

  it("skips a contact whose stored date already matches the swept date", () => {
    expect(
      canSkipContact(
        { ghlContactId: "c1", lastMessageDate: "2026-09-20T10:00:00.000Z" },
        synced("2026-09-20T10:00:00.000Z")
      )
    ).toBe(true);
  });

  it("tolerates the ~1s lag between the conversation stamp and the message's own date", () => {
    // conversations/search.lastMessageDate runs about a second later than the
    // message's dateAdded we store (handoff §13.3). Exact comparison would
    // mark every contact changed forever and silently undo the optimisation.
    expect(
      canSkipContact(
        { ghlContactId: "c1", lastMessageDate: "2026-09-20T10:00:01.100Z" },
        synced("2026-09-20T10:00:00.000Z")
      )
    ).toBe(true);
  });

  it("does not skip when activity genuinely moved", () => {
    expect(
      canSkipContact(
        { ghlContactId: "c1", lastMessageDate: "2026-09-25T10:00:00.000Z" },
        synced("2026-09-20T10:00:00.000Z")
      )
    ).toBe(false);
  });

  it("never skips a cold contact, even when the dates match", () => {
    // A deduped push can land on a GHL contact whose conversation predates the
    // sweep's high-water mark, so a never-synced contact always gets one
    // direct read.
    expect(
      canSkipContact({ ghlContactId: "c1", lastMessageDate: "2026-09-20T10:00:00.000Z" }, [
        { personId: "p1", ghlContactId: "c1", lastActivityAt: null, activitySyncedAt: null },
      ])
    ).toBe(false);
  });

  it("does not skip a synced contact that has no stored date but a swept one", () => {
    expect(
      canSkipContact({ ghlContactId: "c1", lastMessageDate: "2026-09-20T10:00:00.000Z" }, synced(null))
    ).toBe(false);
  });

  it("skips a contact we no longer have a push row for", () => {
    expect(canSkipContact({ ghlContactId: "c1", lastMessageDate: null }, undefined)).toBe(true);
    expect(canSkipContact({ ghlContactId: "c1", lastMessageDate: null }, [])).toBe(true);
  });
});

describe("runGhlActivitySync", () => {
  it("sweeps once, fetches only our contacts, and writes the date and history", async () => {
    const rows = await seedPushedPeople(2);
    const { fetchImpl, calls } = stubGhl({
      conversations: [
        { contactId: rows[0].ghlContactId, lastMessageDate: Date.parse("2026-09-20T10:00:00.000Z") },
        { contactId: rows[1].ghlContactId, lastMessageDate: Date.parse("2026-09-19T10:00:00.000Z") },
        // A conversation for a contact we never pushed — must not cost a call.
        { contactId: "someone-elses-contact", lastMessageDate: Date.parse("2026-09-21T10:00:00.000Z") },
      ],
    });

    const result = await runGhlActivitySync(client, { fetchImpl });

    expect(result.done).toBe(true);
    expect(result.fetched).toBe(2);
    expect(result.updated).toBe(2);
    expect(exportCalls(calls)).toBe(2); // not 3 — the foreign contact is skipped

    const { data: pushes } = await supabaseAdmin
      .from("platform_pushes")
      .select("platform_contact_id,last_activity_at,last_message_type,activity_synced_at")
      .eq("client_id", client.id);
    expect(pushes).toHaveLength(2);
    const byContact = new Map((pushes ?? []).map((p) => [p.platform_contact_id, p]));
    expect(byContact.get(rows[0].ghlContactId)?.last_activity_at).toBe("2026-09-20T10:00:00+00:00");
    expect(byContact.get(rows[1].ghlContactId)?.last_activity_at).toBe("2026-09-19T10:00:00+00:00");
    for (const push of pushes ?? []) {
      expect(push.last_message_type).toBe("TYPE_SMS");
      expect(push.activity_synced_at).not.toBeNull();
    }

    const { data: messages } = await supabaseAdmin
      .from("ghl_messages")
      .select("ghl_message_id,body,direction")
      .eq("client_id", client.id);
    expect(messages).toHaveLength(2);
    expect(messages?.[0].body).toBe("hello");
  });

  it("makes zero export calls on a second run when nothing changed", async () => {
    const rows = await seedPushedPeople(3);
    const conversations = rows.map((r, i) => ({
      contactId: r.ghlContactId,
      lastMessageDate: Date.parse("2026-09-20T10:00:00.000Z") - i * 1000,
    }));

    await runGhlActivitySync(client, { fetchImpl: stubGhl({ conversations }).fetchImpl });

    const second = stubGhl({ conversations });
    const result = await runGhlActivitySync(client, { fetchImpl: second.fetchImpl });

    expect(result.fetched).toBe(0);
    expect(result.skipped).toBe(3);
    expect(exportCalls(second.calls)).toBe(0);
  });

  it("re-fetches only the contact whose activity moved", async () => {
    const rows = await seedPushedPeople(3);
    const base = Date.parse("2026-09-20T10:00:00.000Z");
    const conversations = rows.map((r, i) => ({ contactId: r.ghlContactId, lastMessageDate: base - i * 1000 }));
    await runGhlActivitySync(client, { fetchImpl: stubGhl({ conversations }).fetchImpl });

    const moved = rows[1].ghlContactId;
    const movedMs = Date.parse("2026-09-28T10:00:00.000Z");
    const second = stubGhl({
      conversations: conversations.map((c) =>
        c.contactId === moved ? { ...c, lastMessageDate: movedMs } : c
      ),
      messageDateFor: (contactId) =>
        contactId === moved ? "2026-09-28T10:00:00.000Z" : "2026-09-20T10:00:00.000Z",
    });

    const result = await runGhlActivitySync(client, { fetchImpl: second.fetchImpl });

    expect(exportCalls(second.calls)).toBe(1);
    expect(result.fetched).toBe(1);
    expect(result.skipped).toBe(2);
  });

  it("records a blank date for a contact whose only messages are activity events", async () => {
    const rows = await seedPushedPeople(1);
    const { fetchImpl } = stubGhl({
      conversations: [
        { contactId: rows[0].ghlContactId, lastMessageDate: Date.parse("2026-09-25T13:03:00.000Z") },
      ],
      messageDateFor: () => null, // stub returns an empty export
    });

    await runGhlActivitySync(client, { fetchImpl });

    const { data } = await supabaseAdmin
      .from("platform_pushes")
      .select("last_activity_at,activity_synced_at")
      .eq("client_id", client.id)
      .single();
    expect(data?.last_activity_at).toBeNull();
    // Stamped anyway, so the contact stops being cold and is never re-read
    // directly again.
    expect(data?.activity_synced_at).not.toBeNull();
  });

  it("stops at the deadline and resumes from the queue on the next tick", async () => {
    const rows = await seedPushedPeople(12);
    const base = Date.parse("2026-09-20T10:00:00.000Z");
    const conversations = rows.map((r, i) => ({ contactId: r.ghlContactId, lastMessageDate: base - i * 1000 }));

    // Deadline already passed: the sweep still runs and fills the queue, but
    // the drain loop bails before touching it.
    const first = stubGhl({ conversations });
    const tick1 = await runGhlActivitySync(client, {
      fetchImpl: first.fetchImpl,
      deadline: Date.now() - 1,
    });

    expect(tick1.done).toBe(false);
    expect(tick1.enqueued).toBe(12);
    expect(exportCalls(first.calls)).toBe(0);
    expect(tick1.total).toBe(12);

    const { count: queued } = await supabaseAdmin
      .from("ghl_activity_queue")
      .select("ghl_contact_id", { count: "exact", head: true })
      .eq("client_id", client.id);
    expect(queued).toBe(12);

    // Next tick, no deadline: drains the queue without re-sweeping.
    const second = stubGhl({ conversations });
    const tick2 = await runGhlActivitySync(client, {
      fetchImpl: second.fetchImpl,
      offset: tick1.nextOffset,
    });

    expect(sweepCalls(second.calls)).toBe(0); // queue non-empty => no re-sweep
    expect(tick2.done).toBe(true);
    expect(tick2.fetched).toBe(12);
    expect(tick2.nextOffset).toBe(12);

    const { count: drained } = await supabaseAdmin
      .from("ghl_activity_queue")
      .select("ghl_contact_id", { count: "exact", head: true })
      .eq("client_id", client.id);
    expect(drained).toBe(0);
  });

  it("advances the sweep high-water mark and marks the first pass complete", async () => {
    const rows = await seedPushedPeople(1);
    const newest = Date.parse("2026-09-20T10:00:00.000Z");
    await runGhlActivitySync(client, {
      fetchImpl: stubGhl({ conversations: [{ contactId: rows[0].ghlContactId, lastMessageDate: newest }] })
        .fetchImpl,
    });

    const state = await getSweepState(client.id);
    expect(state.lastMessageDateMs).toBe(newest);
    expect(state.fullSweepCompletedAt).not.toBeNull();
    // A completed pass clears the cursor, so the next sweep starts from the
    // newest conversation again rather than resuming mid-location.
    expect(state.sweepCursorMs).toBeNull();
  });

  it("resumes an interrupted sweep from its cursor instead of restarting", async () => {
    // A first full sweep of a 30k-conversation location is ~305 sequential
    // calls and will not fit in one worker tick. Without a persisted cursor it
    // would re-read the same opening pages every tick, never reach the end,
    // and so never switch early stopping on.
    const rows = await seedPushedPeople(4);
    const base = Date.parse("2026-09-20T10:00:00.000Z");

    // A stub that serves 100-entry pages so the sweep keeps paging, and
    // records the startAfterDate it was asked for.
    const requestedCursors: (string | null)[] = [];
    let pagesServed = 0;
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/conversations/search")) {
        const cursor = new URL(url).searchParams.get("startAfterDate");
        requestedCursors.push(cursor);
        pagesServed++;
        const start = base - pagesServed * 100_000;
        return {
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            conversations: Array.from({ length: 100 }, (_, i) => ({
              id: `conv-${pagesServed}-${i}`,
              contactId: rows[i % rows.length].ghlContactId,
              lastMessageDate: start - i,
              lastMessageType: "TYPE_SMS",
            })),
            total: 100_000,
          }),
        } as unknown as Response;
      }
      return {
        status: 200,
        headers: { get: () => null },
        json: async () => ({ messages: [], nextCursor: null, total: 0 }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    // Deadline just ahead: the sweep gets through a page or two, then stops.
    await runGhlActivitySync(client, { fetchImpl, deadline: Date.now() + 50 });

    const state = await getSweepState(client.id);
    expect(state.fullSweepCompletedAt).toBeNull(); // pass didn't finish
    expect(state.sweepCursorMs).not.toBeNull(); // …so it recorded where to resume

    // Drain the queue so the next tick reaches the sweep phase again.
    await supabaseAdmin.from("ghl_activity_queue").delete().eq("client_id", client.id);

    requestedCursors.length = 0;
    await runGhlActivitySync(client, { fetchImpl, deadline: Date.now() + 50 });

    // The resumed sweep asked GHL to start after the stored cursor, not from
    // the top (which would be a null startAfterDate).
    expect(requestedCursors[0]).toBe(String(state.sweepCursorMs));
  });

  it("clears the resume cursor when a sweep catches up with the mark", async () => {
    // A sweep that pages below the previous run's high-water mark is complete
    // for its purpose. Persisting a cursor there would make the NEXT sweep
    // resume mid-location and never see the newest conversations at all —
    // the opposite of what the mark is for.
    const rows = await seedPushedPeople(2);
    const base = Date.parse("2026-09-20T10:00:00.000Z");
    // A FULL page (100 entries), so the sweep doesn't short-circuit on the
    // "fewer than a page back means we hit the bottom" check and actually
    // exercises the catch-up branch. Only the first two are contacts we own.
    const conversations = Array.from({ length: CONVERSATION_PAGE_SIZE }, (_, i) => ({
      contactId: i < rows.length ? rows[i].ghlContactId : `not-ours-${i}`,
      lastMessageDate: base - i * 1000,
    }));

    await runGhlActivitySync(client, { fetchImpl: stubGhl({ conversations }).fetchImpl });
    expect((await getSweepState(client.id)).fullSweepCompletedAt).not.toBeNull();

    // Second run: the mark is set, so this sweep stops as soon as its first
    // page falls entirely at or below it.
    const second = stubGhl({ conversations });
    await runGhlActivitySync(client, { fetchImpl: second.fetchImpl });
    // One page only — it caught up immediately rather than walking on.
    expect(sweepCalls(second.calls)).toBe(1);

    const state = await getSweepState(client.id);
    expect(state.sweepCursorMs).toBeNull();
    expect(state.lastMessageDateMs).toBe(base);
  });

  it("full mode skips the sweep entirely and re-reads every pushed contact", async () => {
    const rows = await seedPushedPeople(3);
    const base = Date.parse("2026-09-20T10:00:00.000Z");
    const conversations = rows.map((r, i) => ({ contactId: r.ghlContactId, lastMessageDate: base - i * 1000 }));
    await runGhlActivitySync(client, { fetchImpl: stubGhl({ conversations }).fetchImpl });

    const full = stubGhl({ conversations });
    const result = await runGhlActivitySync(client, { fetchImpl: full.fetchImpl, full: true });

    expect(sweepCalls(full.calls)).toBe(0);
    expect(exportCalls(full.calls)).toBe(3);
    expect(result.fetched).toBe(3);
    expect(result.skipped).toBe(0);
  });

  it("counts a failed contact without aborting the rest of the batch", async () => {
    const rows = await seedPushedPeople(3);
    const base = Date.parse("2026-09-20T10:00:00.000Z");
    const conversations = rows.map((r, i) => ({ contactId: r.ghlContactId, lastMessageDate: base - i * 1000 }));
    const broken = rows[1].ghlContactId;

    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes(`contactId=${encodeURIComponent(broken)}`)) {
        return { status: 400, headers: { get: () => null }, json: async () => ({}) } as unknown as Response;
      }
      return stubGhl({ conversations }).fetchImpl(input);
    }) as unknown as typeof fetch;

    const result = await runGhlActivitySync(client, { fetchImpl });

    expect(result.errors).toBe(1);
    expect(result.fetched).toBe(2);
    expect(result.failed[0].name).toBe(broken);
    expect(result.done).toBe(true); // the broken contact is dropped, not left blocking the queue
  });

  it("throws a credentials-shaped error when the token lacks the conversations scope", async () => {
    await seedPushedPeople(1);
    const fetchImpl = (async () =>
      ({
        status: 401,
        headers: { get: () => null },
        json: async () => ({ statusCode: 401, message: "The token is not authorized for this scope." }),
      }) as unknown as Response) as unknown as typeof fetch;

    await expect(runGhlActivitySync(client, { fetchImpl })).rejects.toThrow(
      /token without the conversations scope/
    );
  });
});
