import { beforeEach, describe, expect, it, vi } from "vitest";

const { rpc, selectSpy, rangeResult } = vi.hoisted(() => ({
  rpc: vi.fn(),
  selectSpy: vi.fn(),
  rangeResult: { current: { data: [] as unknown[], count: 0, error: null as unknown } },
}));

const { updateChain } = vi.hoisted(() => ({
  updateChain: { eqCalls: [] as [string, unknown][], rows: [{ id: "job-1" }] as unknown[], error: null as unknown },
}));

vi.mock("@/lib/supabase/admin", () => ({
  supabaseAdmin: {
    rpc,
    from: () => ({
      update: () => {
        const chain = {
          eq: (col: string, val: unknown) => {
            updateChain.eqCalls.push([col, val]);
            return chain;
          },
          select: () => Promise.resolve({ data: updateChain.rows, error: updateChain.error }),
        };
        return chain;
      },
      select: (columns: string, opts?: unknown) => {
        selectSpy(columns, opts);
        const chain = {
          order: () => chain,
          range: () => Promise.resolve(rangeResult.current),
        };
        return chain;
      },
    }),
  },
}));

const {
  toImportJob,
  toImportJobSummary,
  claimNextImportJob,
  resetStaleImportJobs,
  listImportJobs,
  touchImportJobLease,
  updateImportJobProgress,
  advanceImportJobStage,
  finishImportJob,
} = await import(
  "@/lib/data/import-jobs"
);

const rawJob = {
  id: "job-1",
  status: "queued" as const,
  source_key: "manual-csv",
  tags: ["client", "niche", "2026-01-01"],
  stages: [{ targetTable: "companies" as const, columnMap: { Domain: "domain" } }],
  storage_path: "imports/abc.csv",
  file_name: "leads.csv",
  row_count: 10,
  cursor: { stage: 0, offset: 0 },
  stage_results: [],
  total: 0,
  processed: 0,
  inserted: 0,
  updated: 0,
  failed: 0,
  failed_records: [{ domain: "x.com", _failure_reason: "boom" }],
  error: null,
  triggered_by_user_id: "user-1",
  triggered_by_email: "op@example.com",
  created_at: "2026-01-01T00:00:00Z",
  started_at: null,
  finished_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  updateChain.eqCalls = [];
  updateChain.rows = [{ id: "job-1" }];
  updateChain.error = null;
  rangeResult.current = { data: [], count: 0, error: null };
});

describe("toImportJob", () => {
  it("maps snake_case columns to the camelCase job", () => {
    const job = toImportJob(rawJob);
    expect(job).toMatchObject({
      id: "job-1",
      sourceKey: "manual-csv",
      storagePath: "imports/abc.csv",
      fileName: "leads.csv",
      rowCount: 10,
      triggeredByEmail: "op@example.com",
      createdAt: "2026-01-01T00:00:00Z",
    });
    expect(job.failedRecords).toEqual([{ domain: "x.com", _failure_reason: "boom" }]);
  });

  it("defaults null/missing columns so the UI never sees undefined", () => {
    const job = toImportJob({
      ...rawJob,
      tags: null,
      stages: null,
      stage_results: null,
      row_count: null,
      total: null,
      processed: null,
      inserted: null,
      updated: null,
      failed: null,
      failed_records: undefined,
    });
    expect(job).toMatchObject({
      tags: [],
      stages: [],
      stageResults: [],
      rowCount: 0,
      total: 0,
      processed: 0,
      inserted: 0,
      updated: 0,
      failed: 0,
      failedRecords: [],
    });
  });

  it("the summary mapper carries no failedRecords", () => {
    expect(toImportJobSummary(rawJob)).not.toHaveProperty("failedRecords");
  });
});

describe("claimNextImportJob", () => {
  it("returns null when the RPC returns 0 rows", async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    expect(await claimNextImportJob()).toBeNull();
    expect(rpc).toHaveBeenCalledWith("claim_next_import_job");
  });

  it("returns the claimed job", async () => {
    rpc.mockResolvedValue({ data: [{ ...rawJob, status: "running" }], error: null });
    expect(await claimNextImportJob()).toMatchObject({ id: "job-1", status: "running" });
  });

  it("throws on an RPC error", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "nope" } });
    await expect(claimNextImportJob()).rejects.toEqual({ message: "nope" });
  });
});

describe("resetStaleImportJobs", () => {
  it("defaults to a 360s stale window (> maxDuration) and returns the reaped count", async () => {
    rpc.mockResolvedValue({ data: [{}, {}], error: null });
    expect(await resetStaleImportJobs()).toBe(2);
    expect(rpc).toHaveBeenCalledWith("reset_stale_import_jobs", { stale_seconds: 360 });
  });
});

describe("listImportJobs", () => {
  it("does not select failed_records", async () => {
    rangeResult.current = { data: [rawJob], count: 1, error: null };
    const { rows, total } = await listImportJobs(50, 0);
    expect(selectSpy).toHaveBeenCalledTimes(1);
    expect(selectSpy.mock.calls[0][0]).not.toContain("failed_records");
    expect(rows).toHaveLength(1);
    expect(rows[0]).not.toHaveProperty("failedRecords");
    expect(total).toBe(1);
  });
});

describe("conditional write-backs", () => {
  const progress = { total: 1, processed: 1, inserted: 1, updated: 0, failed: 0, failedRecords: [], cursor: { stage: 0, offset: 1 } };
  const writes: [string, () => Promise<boolean>][] = [
    ["touchImportJobLease", () => touchImportJobLease("job-1")],
    ["updateImportJobProgress", () => updateImportJobProgress("job-1", progress)],
    ["advanceImportJobStage", () => advanceImportJobStage("job-1", { stageResults: [], nextStage: 1 })],
    ["finishImportJob", () => finishImportJob("job-1", { status: "succeeded", stageResults: [], inserted: 0, updated: 0, failed: 0 })],
  ];

  for (const [name, run] of writes) {
    it(`${name} only touches a running job and reports whether it matched`, async () => {
      expect(await run()).toBe(true);
      expect(updateChain.eqCalls).toContainEqual(["status", "running"]);
      expect(updateChain.eqCalls).toContainEqual(["id", "job-1"]);

      updateChain.rows = [];
      expect(await run()).toBe(false);

      updateChain.error = { message: "boom" };
      await expect(run()).rejects.toEqual({ message: "boom" });
    });
  }
});
