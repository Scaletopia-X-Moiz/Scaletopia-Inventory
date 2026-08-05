import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ getUser }));

const { listPushJobs } = vi.hoisted(() => ({ listPushJobs: vi.fn() }));
vi.mock("@/lib/data/push-jobs", () => ({ listPushJobs }));

const { GET } = await import("@/app/api/push-jobs/route");

const testUser = { id: "user-1", email: "operator@example.com" };
const req = (query = "") => new NextRequest(`http://localhost/api/push-jobs${query}`);

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue(testUser);
  listPushJobs.mockResolvedValue({ rows: [], total: 0 });
});

describe("GET /api/push-jobs", () => {
  it("returns 401 when there is no session", async () => {
    getUser.mockResolvedValue(null);
    const response = await GET(req());
    expect(response.status).toBe(401);
    expect(listPushJobs).not.toHaveBeenCalled();
  });

  it("passes offset and client/platform/status filters through", async () => {
    await GET(req("?offset=50&clientId=c1&platform=ghl&status=running"));
    expect(listPushJobs).toHaveBeenCalledWith(
      { clientId: "c1", platform: "ghl", status: "running" },
      50,
      50
    );
  });

  it("omits absent filters and defaults offset to 0", async () => {
    await GET(req());
    expect(listPushJobs).toHaveBeenCalledWith({}, 50, 0);
  });

  it("drops an unrecognized status rather than passing it to the query", async () => {
    await GET(req("?status=bogus"));
    expect(listPushJobs).toHaveBeenCalledWith({}, 50, 0);
  });

  it("reports hasMore when the page is full and more rows remain", async () => {
    listPushJobs.mockResolvedValue({ rows: [{ id: "j1" }], total: 60 });
    const response = await GET(req("?offset=50"));
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.rows).toEqual([{ id: "j1" }]);
    expect(body.hasMore).toBe(true);
  });

  it("reports no more rows once the offset reaches the total", async () => {
    listPushJobs.mockResolvedValue({ rows: [{ id: "j1" }], total: 51 });
    const response = await GET(req("?offset=50"));
    const body = await response.json();
    expect(body.hasMore).toBe(false);
  });

  it("returns 500 with the error message when the query throws", async () => {
    listPushJobs.mockRejectedValue(new Error("boom"));
    const response = await GET(req());
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe("boom");
  });
});
