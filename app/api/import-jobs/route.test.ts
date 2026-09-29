import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { after } = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after,
}));

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ getUser }));

const { createImportJob, listImportJobs } = vi.hoisted(() => ({
  createImportJob: vi.fn(),
  listImportJobs: vi.fn(),
}));
vi.mock("@/lib/data/import-jobs", () => ({ createImportJob, listImportJobs }));

const { logActivity } = vi.hoisted(() => ({ logActivity: vi.fn() }));
vi.mock("@/lib/activity/log", () => ({ logActivity }));

const { POST, GET } = await import("@/app/api/import-jobs/route");

const testUser = { id: "user-1", email: "operator@example.com" };

const validBody = {
  path: "imports/abc.csv",
  fileName: "leads.csv",
  rowCount: 12,
  sourceKey: "manual-csv",
  tags: ["client", "niche", "2026-01-01"],
  stages: [{ targetTable: "companies", columnMap: { Domain: "domain" } }],
};

const post = (body: unknown) =>
  new NextRequest("http://localhost/api/import-jobs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const get = (query = "") => new NextRequest(`http://localhost/api/import-jobs${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue(testUser);
  createImportJob.mockResolvedValue({ id: "job-1", fileName: "leads.csv", rowCount: 12 });
  listImportJobs.mockResolvedValue({ rows: [], total: 0 });
});

describe("POST /api/import-jobs", () => {
  it("returns 401 without a user", async () => {
    getUser.mockResolvedValue(null);
    const res = await POST(post(validBody));
    expect(res.status).toBe(401);
    expect(createImportJob).not.toHaveBeenCalled();
  });

  it("400s on a path outside imports/", async () => {
    const res = await POST(post({ ...validBody, path: "other/abc.csv" }));
    expect(res.status).toBe(400);
    expect(createImportJob).not.toHaveBeenCalled();
  });

  it("400s on empty, oversized or unknown stages", async () => {
    for (const stages of [
      [],
      "companies",
      [{ targetTable: "people", columnMap: {} }, { targetTable: "people", columnMap: {} }, { targetTable: "people", columnMap: {} }],
      [{ targetTable: "clients", columnMap: {} }],
      [{ targetTable: "companies" }],
    ]) {
      const res = await POST(post({ ...validBody, stages }));
      expect(res.status).toBe(400);
    }
    expect(createImportJob).not.toHaveBeenCalled();
  });

  it("400s when two stages are not [companies, people]", async () => {
    const res = await POST(
      post({
        ...validBody,
        stages: [
          { targetTable: "people", columnMap: {} },
          { targetTable: "companies", columnMap: {} },
        ],
      })
    );
    expect(res.status).toBe(400);
  });

  it("enqueues a job, logs it, schedules the worker kick, and returns { jobId }", async () => {
    const res = await POST(post(validBody));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jobId: "job-1" });

    expect(createImportJob).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceKey: "manual-csv",
        storagePath: "imports/abc.csv",
        fileName: "leads.csv",
        rowCount: 12,
        triggeredByUserId: "user-1",
        triggeredByEmail: "operator@example.com",
        stages: [{ targetTable: "companies", columnMap: { Domain: "domain" } }],
      })
    );
    expect(logActivity).toHaveBeenCalledWith("import.enqueue", expect.objectContaining({ jobId: "job-1" }), testUser);
    expect(after).toHaveBeenCalledTimes(1);
  });

  it("accepts a [companies, people] two-stage job", async () => {
    const res = await POST(
      post({
        ...validBody,
        stages: [
          { targetTable: "companies", columnMap: {} },
          { targetTable: "people", columnMap: {} },
        ],
      })
    );
    expect(res.status).toBe(200);
  });
});

describe("GET /api/import-jobs", () => {
  it("returns 401 without a user", async () => {
    getUser.mockResolvedValue(null);
    expect((await GET(get())).status).toBe(401);
  });

  it("paginates: page size 50, hasMore while rows remain", async () => {
    listImportJobs.mockResolvedValue({ rows: [{ id: "j1" }], total: 60 });
    const body = await (await GET(get("?offset=50"))).json();
    expect(listImportJobs).toHaveBeenCalledWith(50, 50);
    expect(body).toEqual({ rows: [{ id: "j1" }], hasMore: true });
  });

  it("defaults the offset to 0 and reports no more at the end", async () => {
    listImportJobs.mockResolvedValue({ rows: [{ id: "j1" }], total: 1 });
    const body = await (await GET(get())).json();
    expect(listImportJobs).toHaveBeenCalledWith(50, 0);
    expect(body.hasMore).toBe(false);
  });
});
