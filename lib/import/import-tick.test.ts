import { beforeEach, describe, expect, it, vi } from "vitest";

// Mocked supabase: the "companies" table starts with `existingRows`, inserts are
// recorded, and RPCs succeed. No live DB is touched.
const { state } = vi.hoisted(() => ({
  state: {
    existingRows: [] as Record<string, unknown>[],
    peopleRows: [] as Record<string, unknown>[],
    selectCalls: 0,
    selectTables: [] as string[],
    failSelectOn: null as string | null,
    inserted: [] as Record<string, unknown>[][],
    insertedByTable: {} as Record<string, Record<string, unknown>[][]>,
    historyRows: [] as Record<string, unknown>[],
    rpcCalls: [] as { fn: string; count: number }[],
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: () => {
        state.selectCalls++;
        state.selectTables.push(table);
        const rows = table === "people" ? state.peopleRows : state.existingRows;
        const result =
          state.failSelectOn === table
            ? { data: null, count: null, error: { message: "select exploded" } }
            : { data: rows, count: rows.length, error: null };
        return { order: () => ({ range: () => Promise.resolve(result) }) };
      },
      insert: (batch: Record<string, unknown> | Record<string, unknown>[]) => {
        if (table === "import_history") {
          state.historyRows.push(batch as Record<string, unknown>);
          return Object.assign(Promise.resolve({ error: null }), {
            select: () => ({ single: async () => ({ data: { id: "hist-1" } }) }),
          });
        }
        const list = batch as Record<string, unknown>[];
        state.inserted.push(list);
        (state.insertedByTable[table] ??= []).push(list);
        return Promise.resolve({ error: null });
      },
    }),
    rpc: (fn: string, args: { updates: unknown[] }) => {
      state.rpcCalls.push({ fn, count: args.updates.length });
      return Promise.resolve({ error: null });
    },
  },
}));

const { prepareImportRecords, runImportTick, pushRecords } = await import("@/lib/import/push");

const TAGS: [string, string, string] = ["client", "niche", "2026-01-01"];

function company(i: number): Record<string, unknown> {
  return { company_name: `Co ${i}`, domain: `co${i}.example.com` };
}

const records = [1, 2, 3, 4, 5].map(company);

beforeEach(() => {
  state.existingRows = [];
  state.peopleRows = [];
  state.selectCalls = 0;
  state.selectTables = [];
  state.failSelectOn = null;
  state.inserted = [];
  state.insertedByTable = {};
  state.historyRows = [];
  state.rpcCalls = [];
});

describe("prepareImportRecords", () => {
  it("is deterministic: same input, same output order", () => {
    const input = [
      { company_name: "B", domain: "https://www.B.com/" },
      { company_name: "A", domain: "a.com" },
      { company_name: "B again", domain: "b.com" },
      { company_name: "C", website_url: "https://c.com/about" },
    ];
    const first = prepareImportRecords(input, "companies");
    const second = prepareImportRecords(input, "companies");
    expect(second).toEqual(first);
    expect(first.map((r) => r.domain)).toEqual(["b.com", "a.com", "c.com"]);
  });

  it("derives a people full_name only when deriveNames is on", () => {
    const input = [{ first_name: "Ada", last_name: "Lovelace", email: "ada@x.com" }];
    expect(prepareImportRecords(input, "people")[0].full_name).toBe("Ada Lovelace");
    expect(prepareImportRecords(input, "people", { deriveNames: false })[0].full_name).toBeUndefined();
  });
});

describe("runImportTick", () => {
  const base = { targetTable: "companies" as const, sourceKey: "test", tags: TAGS };

  it("processes everything and reports done when the deadline never passes", async () => {
    const res = await runImportTick({ ...base, records, offset: 0, deadline: Infinity, chunkSize: 2 });
    expect(res).toMatchObject({ dedupedCount: 5, nextOffset: 5, done: true, inserted: 5, updated: 0 });
    expect(state.inserted.flat()).toHaveLength(5);
  });

  it("stops after the chunk in flight once the deadline has passed", async () => {
    const res = await runImportTick({ ...base, records, offset: 0, deadline: Date.now() - 1, chunkSize: 2 });
    // At least one chunk always runs, then it stops.
    expect(res).toMatchObject({ dedupedCount: 5, nextOffset: 2, done: false, inserted: 2 });
    expect(state.inserted.flat().map((r) => r.domain)).toEqual(["co1.example.com", "co2.example.com"]);
  });

  it("resumes from offset and only touches the remaining records", async () => {
    const res = await runImportTick({ ...base, records, offset: 2, deadline: Infinity, chunkSize: 2 });
    expect(res).toMatchObject({ nextOffset: 5, done: true, inserted: 3 });
    expect(state.inserted.flat().map((r) => r.domain)).toEqual([
      "co3.example.com",
      "co4.example.com",
      "co5.example.com",
    ]);
  });

  it("treats an offset past the end as done with nothing to do", async () => {
    const res = await runImportTick({ ...base, records, offset: 99, deadline: Infinity });
    expect(res).toMatchObject({ dedupedCount: 5, done: true, inserted: 0, updated: 0 });
    expect(state.inserted).toHaveLength(0);
  });

  it("classifies existing records as updates and fetches existing keys once per tick", async () => {
    state.existingRows = [{ domain: "co2.example.com", linkedin_url: null }];
    const res = await runImportTick({ ...base, records, offset: 0, deadline: Infinity, chunkSize: 2 });
    expect(res).toMatchObject({ done: true, inserted: 4, updated: 1 });
    expect(state.rpcCalls).toEqual([{ fn: "import_bulk_update_companies", count: 1 }]);
    // One existing-keys fetch for the whole tick, across all three chunks.
    expect(state.selectCalls).toBe(1);
  });

  it("keeps the live partial sink current after each chunk", async () => {
    const partial = { dedupedCount: 0, nextOffset: 0, done: false, inserted: 0, updated: 0, failedRecords: [] };
    await runImportTick({ ...base, records, offset: 0, deadline: Date.now() - 1, chunkSize: 2, partial });
    expect(partial).toMatchObject({ dedupedCount: 5, nextOffset: 2, inserted: 2 });
  });
});

describe("runImportTick checkpoints and budget", () => {
  const base = { targetTable: "companies" as const, sourceKey: "test", tags: TAGS };

  it("checkpoints once after dedupe (total known early) and once per chunk", async () => {
    const seen: { nextOffset: number; dedupedCount: number; inserted: number }[] = [];
    await runImportTick({
      ...base,
      records,
      offset: 0,
      deadline: Infinity,
      chunkSize: 2,
      onCheckpoint: async (s) => {
        seen.push({ nextOffset: s.nextOffset, dedupedCount: s.dedupedCount, inserted: s.inserted });
      },
    });
    expect(seen).toEqual([
      { nextOffset: 0, dedupedCount: 5, inserted: 0 },
      { nextOffset: 2, dedupedCount: 5, inserted: 2 },
      { nextOffset: 4, dedupedCount: 5, inserted: 4 },
      { nextOffset: 5, dedupedCount: 5, inserted: 5 },
    ]);
  });

  it("propagates a checkpoint failure out of the tick", async () => {
    await expect(
      runImportTick({
        ...base,
        records,
        offset: 0,
        deadline: Infinity,
        chunkSize: 2,
        onCheckpoint: async () => {
          throw new Error("db down");
        },
      })
    ).rejects.toThrow("db down");
  });

  it("does not start a new chunk when the remaining budget is under minChunkMs, but always runs one", async () => {
    const res = await runImportTick({
      ...base,
      records,
      offset: 0,
      deadline: Date.now() + 30_000,
      minChunkMs: 60_000,
      chunkSize: 2,
    });
    expect(res).toMatchObject({ nextOffset: 2, done: false, inserted: 2 });
  });

  it("keeps going when the budget comfortably exceeds minChunkMs", async () => {
    const res = await runImportTick({
      ...base,
      records,
      offset: 0,
      deadline: Date.now() + 600_000,
      minChunkMs: 60_000,
      chunkSize: 2,
    });
    expect(res).toMatchObject({ nextOffset: 5, done: true });
  });

  it("stops before any chunk when shouldStop is true", async () => {
    const res = await runImportTick({ ...base, records, offset: 0, deadline: Infinity, shouldStop: () => true });
    expect(res).toMatchObject({ nextOffset: 0, done: false, inserted: 0 });
    expect(state.inserted).toHaveLength(0);
  });

  it("re-inserts keyless rows on a rerun (documented non-idempotency)", async () => {
    const keyless = [{ company_name: "No Key Inc" }];
    await runImportTick({ ...base, records: keyless, offset: 0, deadline: Infinity });
    // Simulate the rerun of the same chunk: the row still has no key to match.
    await runImportTick({ ...base, records: keyless, offset: 0, deadline: Infinity });
    expect(state.inserted.flat()).toHaveLength(2);
  });
});

describe("runImportTick people path", () => {
  const base = { targetTable: "people" as const, sourceKey: "test", tags: TAGS };

  it("links company_id per chunk from one company lookup, and updates existing people", async () => {
    state.existingRows = [{ id: "c1", domain: "acme.com", client: "client", niche: null }];
    state.peopleRows = [{ email: "old@acme.com", linkedin_url: null }];
    const people = [
      { email: "new@acme.com", full_name: "New One", domain: "acme.com" },
      { email: "old@acme.com", full_name: "Old One", domain: "acme.com" },
      { email: "stray@other.com", full_name: "Stray", domain: "other.com" },
    ];
    const res = await runImportTick({ ...base, records: people, offset: 0, deadline: Infinity, chunkSize: 2 });

    expect(res).toMatchObject({ dedupedCount: 3, done: true, inserted: 2, updated: 1 });
    // people keys + companies lookup, each fetched once for the whole tick.
    expect(state.selectTables.sort()).toEqual(["companies", "people"]);
    const insertedPeople = (state.insertedByTable.people ?? []).flat();
    expect(insertedPeople.find((r) => r.email === "new@acme.com")?.company_id).toBe("c1");
    expect(insertedPeople.find((r) => r.email === "stray@other.com")?.company_id).toBeNull();
    expect(state.rpcCalls).toEqual([{ fn: "import_bulk_update_people", count: 1 }]);
  });
});

describe("pushRecords wrapper (mocked, no live DB)", () => {
  const options = { records, targetTable: "companies" as const, sourceKey: "test", tags: TAGS };

  it("runs every chunk and writes one import_history row", async () => {
    state.existingRows = [{ domain: "co1.example.com", linkedin_url: null }];
    const res = await pushRecords(options, () => {});
    expect(res).toMatchObject({
      inputCount: 5,
      dedupedCount: 5,
      insertedCount: 4,
      updatedCount: 1,
      failedCount: 0,
      historyId: "hist-1",
    });
    expect(state.historyRows).toHaveLength(1);
    expect(state.historyRows[0]).toMatchObject({ inserted_count: 4, updated_count: 1, failed_count: 0, input_count: 5 });
  });

  it("BUG E: a mid-run throw still writes a partial history row and rethrows", async () => {
    state.failSelectOn = "companies";
    await expect(pushRecords(options, () => {})).rejects.toThrow(/select exploded/);
    expect(state.historyRows).toHaveLength(1);
    expect(state.historyRows[0]).toMatchObject({ deduped_count: 5, inserted_count: 0, failed_count: 1 });
    expect((state.historyRows[0].failed_records as Record<string, unknown>[])[0]).toMatchObject({ _partial: true });
  });
});
