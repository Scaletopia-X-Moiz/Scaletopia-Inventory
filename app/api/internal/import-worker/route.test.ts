import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ImportJob } from "@/lib/data/import-jobs";

const { after } = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", () => ({ after }));

const {
  claimNextImportJob,
  resetStaleImportJobs,
  getImportJob,
  updateImportJobProgress,
  touchImportJobLease,
  finishImportJob,
  advanceImportJobStage,
} = vi.hoisted(() => ({
  claimNextImportJob: vi.fn(),
  resetStaleImportJobs: vi.fn(),
  getImportJob: vi.fn(),
  updateImportJobProgress: vi.fn(),
  touchImportJobLease: vi.fn(),
  finishImportJob: vi.fn(),
  advanceImportJobStage: vi.fn(),
}));
vi.mock("@/lib/data/import-jobs", () => ({
  claimNextImportJob,
  resetStaleImportJobs,
  getImportJob,
  updateImportJobProgress,
  touchImportJobLease,
  finishImportJob,
  advanceImportJobStage,
}));

const { runImportTick } = vi.hoisted(() => ({ runImportTick: vi.fn() }));
vi.mock("@/lib/import/push", () => ({ runImportTick }));

const { logActivity } = vi.hoisted(() => ({ logActivity: vi.fn() }));
vi.mock("@/lib/activity/log", () => ({ logActivity }));

const { download, remove, historyInsert, historyExisting } = vi.hoisted(() => ({
  download: vi.fn(),
  remove: vi.fn(),
  historyInsert: vi.fn(),
  historyExisting: { current: [] as { id: string }[] },
}));
vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    storage: { from: () => ({ download, remove }) },
    from: (table: string) => ({
      select: () => {
        const chain = {
          eq: () => chain,
          limit: async () => ({ data: historyExisting.current }),
        };
        return chain;
      },
      insert: (row: Record<string, unknown>) => {
        historyInsert(table, row);
        return { select: () => ({ single: async () => ({ data: { id: `hist-${historyInsert.mock.calls.length}` } }) }) };
      },
    }),
  },
}));

const { GET, POST } = await import("@/app/api/internal/import-worker/route");

const CSV = "Domain,Name\na.com,A\nb.com,B\n";

function makeJob(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    id: "job-1",
    status: "running",
    sourceKey: "manual-csv",
    tags: ["client", "niche", "2026-01-01"],
    stages: [{ targetTable: "companies", columnMap: { Domain: "domain", Name: "company_name" } }],
    storagePath: "imports/abc.csv",
    fileName: "leads.csv",
    rowCount: 2,
    cursor: { stage: 0, offset: 0 },
    stageResults: [],
    total: 0,
    processed: 0,
    inserted: 0,
    updated: 0,
    failed: 0,
    error: null,
    triggeredByUserId: "user-1",
    triggeredByEmail: "op@example.com",
    createdAt: "2026-01-01T00:00:00Z",
    startedAt: "2026-01-01T00:00:00Z",
    finishedAt: null,
    failedRecords: [],
    ...overrides,
  };
}

function tickResult(overrides: Record<string, unknown> = {}) {
  return { dedupedCount: 2, nextOffset: 2, done: true, inserted: 2, updated: 0, failedRecords: [], ...overrides };
}

const req = (init: RequestInit = { method: "POST" }) =>
  new Request("http://localhost/api/internal/import-worker", init);

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  delete process.env.PUSH_WORKER_SECRET;
  resetStaleImportJobs.mockResolvedValue(0);
  download.mockResolvedValue({ data: { text: async () => CSV }, error: null });
  remove.mockResolvedValue({ error: null });
  historyExisting.current = [];
  touchImportJobLease.mockResolvedValue(true);
  updateImportJobProgress.mockResolvedValue(true);
  finishImportJob.mockResolvedValue(true);
  advanceImportJobStage.mockResolvedValue(true);
});

describe("import-worker auth", () => {
  it("401s when CRON_SECRET is set but the header is wrong", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await GET(new Request("http://localhost/api/internal/import-worker"));
    expect(res.status).toBe(401);
    expect(claimNextImportJob).not.toHaveBeenCalled();
  });

  it("accepts a matching x-worker-secret header", async () => {
    process.env.PUSH_WORKER_SECRET = "wsecret";
    claimNextImportJob.mockResolvedValue(null);
    const res = await POST(req({ method: "POST", headers: { "x-worker-secret": "wsecret" } }));
    expect(res.status).toBe(200);
  });
});

describe("import-worker reaper", () => {
  it("runs the reaper before claiming", async () => {
    resetStaleImportJobs.mockResolvedValue(1);
    claimNextImportJob.mockResolvedValue(null);

    expect((await POST(req())).status).toBe(200);
    expect(resetStaleImportJobs).toHaveBeenCalledTimes(1);
    expect(resetStaleImportJobs.mock.invocationCallOrder[0]).toBeLessThan(
      claimNextImportJob.mock.invocationCallOrder[0]
    );
  });

  it("carries on when the reaper throws (SQL not yet applied)", async () => {
    resetStaleImportJobs.mockRejectedValue(new Error("function does not exist"));
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult());

    expect((await POST(req())).status).toBe(200);
    expect(finishImportJob).toHaveBeenCalledWith("job-1", expect.objectContaining({ status: "succeeded" }));
  });
});

describe("import-worker tick", () => {
  it("finishes a job in one tick: writes history, finishes, logs, removes the CSV", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult());

    const res = await POST(req());
    expect(await res.json()).toMatchObject({ ok: true, processed: 1, chained: false });

    expect(runImportTick).toHaveBeenCalledWith(
      expect.objectContaining({ targetTable: "companies", offset: 0, sourceKey: "manual-csv" })
    );
    // Records handed to the tick were mapped from the CSV with the stage's column map.
    expect(runImportTick.mock.calls[0][0].records).toEqual([
      { domain: "a.com", company_name: "A" },
      { domain: "b.com", company_name: "B" },
    ]);

    expect(historyInsert).toHaveBeenCalledTimes(1);
    expect(historyInsert).toHaveBeenCalledWith(
      "import_history",
      expect.objectContaining({
        source_key: "manual-csv",
        target_table: "companies",
        input_count: 2,
        deduped_count: 2,
        inserted_count: 2,
        updated_count: 0,
        failed_count: 0,
        import_job_id: "job-1",
        started_at: "2026-01-01T00:00:00Z",
      })
    );
    expect(finishImportJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        status: "succeeded",
        inserted: 2,
        stageResults: [expect.objectContaining({ targetTable: "companies", inserted: 2, historyId: "hist-1" })],
      })
    );
    expect(logActivity).toHaveBeenCalledWith("import.run", expect.objectContaining({ jobId: "job-1" }), expect.anything());
    expect(remove).toHaveBeenCalledWith(["imports/abc.csv"]);
    expect(after).not.toHaveBeenCalled();
  });

  it("marks a job with some failures 'partial' and a job with only failures 'failed'", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult({ inserted: 1, failedRecords: [{ domain: "b.com", _failure_reason: "x" }] }));
    await POST(req());
    expect(finishImportJob).toHaveBeenLastCalledWith("job-1", expect.objectContaining({ status: "partial", failed: 1 }));

    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult({ inserted: 0, failedRecords: [{ domain: "a.com" }, { domain: "b.com" }] }));
    await POST(req());
    expect(finishImportJob).toHaveBeenLastCalledWith("job-1", expect.objectContaining({ status: "failed", failed: 2 }));
  });

  it("persists the cursor and self-chains with jobId when the tick is not done", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult({ done: false, nextOffset: 1, inserted: 1 }));

    const res = await POST(req());
    expect(await res.json()).toMatchObject({ processed: 1, chained: true });

    expect(updateImportJobProgress).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ total: 2, processed: 1, inserted: 1, cursor: { stage: 0, offset: 1 } })
    );
    expect(finishImportJob).not.toHaveBeenCalled();
    expect(historyInsert).not.toHaveBeenCalled();
    // The CSV must survive between ticks.
    expect(remove).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("resumes from the saved cursor and accumulates onto the job's running totals", async () => {
    claimNextImportJob.mockResolvedValueOnce(
      makeJob({ cursor: { stage: 0, offset: 1 }, inserted: 1, failed: 0, processed: 1, total: 2 })
    );
    runImportTick.mockResolvedValue(tickResult({ nextOffset: 2, inserted: 1 }));

    await POST(req());
    expect(runImportTick).toHaveBeenCalledWith(expect.objectContaining({ offset: 1 }));
    expect(finishImportJob).toHaveBeenCalledWith("job-1", expect.objectContaining({ inserted: 2 }));
  });

  it("advances from stage 0 to stage 1 for a two-stage job, one history row per stage", async () => {
    const job = makeJob({
      stages: [
        { targetTable: "companies", columnMap: { Domain: "domain", Name: "company_name" } },
        { targetTable: "people", columnMap: { Name: "full_name" } },
      ],
    });
    claimNextImportJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult());

    await POST(req());

    // Both stages ran in the same invocation, in order.
    expect(runImportTick.mock.calls.map((c) => c[0].targetTable)).toEqual(["companies", "people"]);
    expect(advanceImportJobStage).toHaveBeenCalledWith("job-1", {
      stageResults: [expect.objectContaining({ targetTable: "companies", historyId: "hist-1" })],
      nextStage: 1,
    });
    expect(historyInsert).toHaveBeenCalledTimes(2);
    expect(finishImportJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({
        status: "succeeded",
        stageResults: [
          expect.objectContaining({ targetTable: "companies" }),
          expect.objectContaining({ targetTable: "people" }),
        ],
      })
    );
    // Stage counters reset for stage 2: it's not double-counted onto stage 1.
    expect(finishImportJob.mock.calls[0][1].inserted).toBe(2);
  });

  it("starts at stage 1 when the cursor is already there", async () => {
    const job = makeJob({
      stages: [
        { targetTable: "companies", columnMap: { Domain: "domain" } },
        { targetTable: "people", columnMap: { Name: "full_name" } },
      ],
      cursor: { stage: 1, offset: 0 },
      stageResults: [
        { targetTable: "companies", inputCount: 2, dedupedCount: 2, inserted: 2, updated: 0, failed: 0, historyId: "h0" },
      ],
    });
    claimNextImportJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult());

    await POST(req());
    expect(runImportTick.mock.calls.map((c) => c[0].targetTable)).toEqual(["people"]);
    expect(advanceImportJobStage).not.toHaveBeenCalled();
  });

  it("fails the job and writes a partial history row when a tick throws", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockImplementation(async (opts: { partial: Record<string, unknown> }) => {
      Object.assign(opts.partial, { dedupedCount: 2, inserted: 1 });
      throw new Error("db exploded");
    });

    const res = await POST(req());
    expect(res.status).toBe(200);

    expect(historyInsert).toHaveBeenCalledWith(
      "import_history",
      expect.objectContaining({
        inserted_count: 1,
        deduped_count: 2,
        failed_count: 1,
        failed_records: [{ _import_error: "db exploded", _partial: true }],
      })
    );
    expect(finishImportJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ status: "failed", error: "db exploded", inserted: 1 })
    );
    expect(remove).toHaveBeenCalledWith(["imports/abc.csv"]);
  });

  it("fails the job when the CSV is missing from storage", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    download.mockResolvedValue({ data: null, error: { message: "Object not found" } });

    await POST(req());
    expect(runImportTick).not.toHaveBeenCalled();
    expect(finishImportJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ status: "failed", error: expect.stringContaining("missing from storage") })
    );
  });
});

describe("import-worker resume-by-jobId", () => {
  const resumeReq = () =>
    req({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jobId: "job-1" }) });

  it("resumes a still-running job directly without claiming it", async () => {
    getImportJob.mockResolvedValue(makeJob({ cursor: { stage: 0, offset: 1 } }));
    claimNextImportJob.mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult());

    await POST(resumeReq());
    expect(getImportJob).toHaveBeenCalledWith("job-1");
    expect(runImportTick).toHaveBeenCalledWith(expect.objectContaining({ offset: 1 }));
  });

  it("falls through to claim when the resumed job is already terminal", async () => {
    getImportJob.mockResolvedValue(makeJob({ status: "succeeded" }));
    claimNextImportJob.mockResolvedValue(null);

    await POST(resumeReq());
    expect(runImportTick).not.toHaveBeenCalled();
    expect(claimNextImportJob).toHaveBeenCalledTimes(1);
  });
});

const fail = (n: number, tag = "x") => Array.from({ length: n }, (_, i) => ({ domain: `${tag}${i}.com`, _failure_reason: "boom" }));

describe("import-worker lease and write-back guards", () => {
  it("renews the lease from an interval for the whole tick and stops after it", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
      runImportTick.mockImplementation(async () => {
        await vi.advanceTimersByTimeAsync(95_000); // long key fetch / slow chunk
        return tickResult();
      });
      await POST(req());
      expect(touchImportJobLease).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(touchImportJobLease).toHaveBeenCalledTimes(3); // cleared in finally
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops quietly when the heartbeat learns the job is no longer running", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
      touchImportJobLease.mockResolvedValue(false);
      let stopped = false;
      runImportTick.mockImplementation(async (opts: { shouldStop: () => boolean }) => {
        await vi.advanceTimersByTimeAsync(31_000);
        stopped = opts.shouldStop();
        return tickResult({ done: false, nextOffset: 0, inserted: 0 });
      });
      const res = await POST(req());
      expect(stopped).toBe(true);
      expect(await res.json()).toMatchObject({ chained: false });
      expect(finishImportJob).not.toHaveBeenCalled();
      expect(historyInsert).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
      expect(after).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("a progress write that matches no running row ends the tick without finish, delete or chain", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult({ done: false, nextOffset: 1, inserted: 1 }));
    updateImportJobProgress.mockResolvedValue(false);
    const res = await POST(req());
    expect(await res.json()).toMatchObject({ processed: 1, chained: false });
    expect(finishImportJob).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("a final finish that matches no running row does not delete the CSV or log", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult());
    finishImportJob.mockResolvedValue(false);
    await POST(req());
    expect(remove).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("persists cursor and counts from the per-chunk checkpoint, with total set early", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob({ inserted: 10, cursor: { stage: 0, offset: 4 } })).mockResolvedValue(null);
    runImportTick.mockImplementation(async (opts: { onCheckpoint: (s: unknown) => Promise<void> }) => {
      await opts.onCheckpoint({ dedupedCount: 50, nextOffset: 4, done: false, inserted: 0, updated: 0, failedRecords: [] });
      await opts.onCheckpoint({ dedupedCount: 50, nextOffset: 6, done: false, inserted: 2, updated: 0, failedRecords: [] });
      return tickResult({ dedupedCount: 50, nextOffset: 50, inserted: 46 });
    });
    await POST(req());
    expect(updateImportJobProgress).toHaveBeenNthCalledWith(
      1,
      "job-1",
      expect.objectContaining({ total: 50, processed: 4, inserted: 10, cursor: { stage: 0, offset: 4 } })
    );
    expect(updateImportJobProgress).toHaveBeenNthCalledWith(
      2,
      "job-1",
      expect.objectContaining({ total: 50, processed: 6, inserted: 12, cursor: { stage: 0, offset: 6 } })
    );
  });
});

describe("import-worker failure handling", () => {
  it("a failed progress write leaves the job running: no finish, no history, CSV kept, no chain", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult({ done: false, nextOffset: 1, inserted: 1 }));
    updateImportJobProgress.mockRejectedValue(new Error("db blip"));
    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(finishImportJob).not.toHaveBeenCalled();
    expect(historyInsert).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(after).not.toHaveBeenCalled();
  });

  it("a failed advance write leaves the job running", async () => {
    const job = makeJob({
      stages: [
        { targetTable: "companies", columnMap: { Domain: "domain" } },
        { targetTable: "people", columnMap: { Name: "full_name" } },
      ],
    });
    claimNextImportJob.mockResolvedValueOnce(job).mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult());
    advanceImportJobStage.mockRejectedValue(new Error("db blip"));
    await POST(req());
    expect(finishImportJob).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
  });

  it("does not double-count a tick in the partial history row when a later write fails", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockImplementation(async (opts: { partial: Record<string, unknown> }) => {
      Object.assign(opts.partial, { dedupedCount: 2, inserted: 1 });
      throw new Error("chunk failed");
    });
    await POST(req());
    expect(historyInsert).toHaveBeenCalledWith("import_history", expect.objectContaining({ inserted_count: 1 }));
    expect(finishImportJob).toHaveBeenCalledWith("job-1", expect.objectContaining({ inserted: 1 }));
  });

  it("does not delete the CSV when marking the job failed itself fails", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockRejectedValue(new Error("db exploded"));
    finishImportJob.mockRejectedValue(new Error("db still down"));
    await POST(req());
    expect(remove).not.toHaveBeenCalled();
    expect(logActivity).not.toHaveBeenCalled();
  });

  it("does not delete the CSV when the failure write matched no running row", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockRejectedValue(new Error("db exploded"));
    finishImportJob.mockResolvedValue(false);
    await POST(req());
    expect(remove).not.toHaveBeenCalled();
  });

  it("deletes the CSV after a successful failure write and logs the counts", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockImplementation(async (opts: { partial: Record<string, unknown> }) => {
      Object.assign(opts.partial, { dedupedCount: 2, inserted: 1 });
      throw new Error("db exploded");
    });
    await POST(req());
    expect(remove).toHaveBeenCalledWith(["imports/abc.csv"]);
    expect(logActivity).toHaveBeenCalledWith(
      "import.run",
      expect.objectContaining({ failed: true, insertedCount: 1, error: "db exploded" }),
      expect.anything()
    );
  });

  it("treats a transient storage error as retryable, not a missing CSV", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    download.mockResolvedValue({ data: null, error: { message: "upstream 503", statusCode: "503" } });
    await POST(req());
    expect(finishImportJob).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(runImportTick).not.toHaveBeenCalled();
  });
});

describe("import-worker stages, history and activity", () => {
  const twoStage = () =>
    makeJob({
      stages: [
        { targetTable: "companies", columnMap: { Domain: "domain", Name: "company_name" } },
        { targetTable: "people", columnMap: { Name: "full_name" } },
      ],
    });

  it("logs one import.run per stage with that stage's counts", async () => {
    claimNextImportJob.mockResolvedValueOnce(twoStage()).mockResolvedValue(null);
    runImportTick
      .mockResolvedValueOnce(tickResult({ inserted: 2 }))
      .mockResolvedValueOnce(tickResult({ inserted: 1, updated: 1 }));
    await POST(req());
    const runs = logActivity.mock.calls.filter((c) => c[0] === "import.run").map((c) => c[1]);
    expect(runs).toEqual([
      expect.objectContaining({ targetTable: "companies", insertedCount: 2, stage: 1, stageCount: 2 }),
      expect.objectContaining({ targetTable: "people", insertedCount: 1, updatedCount: 1, stage: 2, stageCount: 2 }),
    ]);
  });

  it("hands off before stage 2 when the remaining budget is too small", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      claimNextImportJob.mockResolvedValueOnce(twoStage()).mockResolvedValue(null);
      runImportTick.mockImplementationOnce(async () => {
        vi.setSystemTime(Date.now() + 200_000); // leaves < 120s of the 270s worker budget
        return tickResult();
      });
      const res = await POST(req());
      expect(await res.json()).toMatchObject({ chained: true });
      expect(runImportTick).toHaveBeenCalledTimes(1);
      expect(advanceImportJobStage).toHaveBeenCalledTimes(1);
      expect(finishImportJob).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reuses an existing history row for the stage instead of inserting a second", async () => {
    historyExisting.current = [{ id: "hist-existing" }];
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult());
    await POST(req());
    expect(historyInsert).not.toHaveBeenCalled();
    expect(finishImportJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ stageResults: [expect.objectContaining({ historyId: "hist-existing" })] })
    );
  });
});

describe("import-worker failed-record cap", () => {
  it("keeps the first 5000 records plus one truncation marker, with the true failed count", async () => {
    claimNextImportJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult({ inserted: 0, failedRecords: fail(6000) }));
    await POST(req());
    const finish = finishImportJob.mock.calls[0][1];
    expect(finish.failed).toBe(6000);
    expect(finish.failedRecords).toHaveLength(5001);
    expect(finish.failedRecords[5000]).toMatchObject({ _truncated: true });
    expect(finish.failedRecords.filter((r: Record<string, unknown>) => r._truncated)).toHaveLength(1);
  });

  it("does not duplicate the marker or exceed the cap across resumed ticks", async () => {
    const existing = [...fail(5000), { _truncated: true, _note: "old" }];
    claimNextImportJob.mockResolvedValueOnce(makeJob({ failed: 5200, failedRecords: existing, cursor: { stage: 0, offset: 1 } })).mockResolvedValue(null);
    runImportTick.mockResolvedValue(tickResult({ inserted: 0, failedRecords: fail(300, "y") }));
    await POST(req());
    const finish = finishImportJob.mock.calls[0][1];
    expect(finish.failed).toBe(5500);
    expect(finish.failedRecords).toHaveLength(5001);
    expect(finish.failedRecords.filter((r: Record<string, unknown>) => r._truncated)).toHaveLength(1);
  });
});
