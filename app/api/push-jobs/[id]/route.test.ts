import { describe, expect, it, vi, beforeEach } from "vitest";

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ getUser }));

const { getPushJob } = vi.hoisted(() => ({ getPushJob: vi.fn() }));
vi.mock("@/lib/data/push-jobs", () => ({ getPushJob }));

const { GET } = await import("@/app/api/push-jobs/[id]/route");

const testUser = { id: "user-1", email: "operator@example.com" };
const req = () => new Request("http://localhost/api/push-jobs/job-1");
const params = (id: string) => Promise.resolve({ id });

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue(testUser);
});

describe("GET /api/push-jobs/[id]", () => {
  it("returns 401 when there is no session", async () => {
    getUser.mockResolvedValue(null);
    const response = await GET(req(), { params: params("job-1") });
    expect(response.status).toBe(401);
    expect(getPushJob).not.toHaveBeenCalled();
  });

  it("returns 404 when the job doesn't exist", async () => {
    getPushJob.mockResolvedValue(null);
    const response = await GET(req(), { params: params("missing") });
    expect(response.status).toBe(404);
  });

  it("returns the job when found", async () => {
    const job = { id: "job-1", status: "running", total: 10, processed: 4 };
    getPushJob.mockResolvedValue(job);
    const response = await GET(req(), { params: params("job-1") });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(job);
    expect(getPushJob).toHaveBeenCalledWith("job-1");
  });
});
