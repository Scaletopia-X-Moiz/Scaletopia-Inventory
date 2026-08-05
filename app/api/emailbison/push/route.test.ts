import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { ClientRow } from "@/lib/data/clients";

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ getUser }));

const { getClientById } = vi.hoisted(() => ({ getClientById: vi.fn() }));
vi.mock("@/lib/data/clients", () => ({ getClientById }));

const { createPushJob } = vi.hoisted(() => ({ createPushJob: vi.fn() }));
vi.mock("@/lib/data/push-jobs", () => ({ createPushJob }));

// Keep NextRequest real; stub `after` to a no-op so the fire-and-forget worker
// kick doesn't actually run during the test.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn() };
});

const { POST } = await import("@/app/api/emailbison/push/route");

const testUser = { id: "user-1", email: "operator@example.com" };
const testClient: ClientRow = {
  id: "client-1",
  slug: "acme",
  name: "Acme",
  ghlApiKey: null,
  ghlLocationId: null,
  emailbisonApiKey: "key",
  emailbisonWorkspaceId: "ws",
  isActive: true,
  updatedAt: new Date().toISOString(),
};

function makeRequest(body: unknown, query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/emailbison/push${query}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue(testUser);
  getClientById.mockResolvedValue(testClient);
  createPushJob.mockResolvedValue({ id: "job-abc" });
});

describe("POST /api/emailbison/push (enqueue-only)", () => {
  it("returns 401 when there is no session", async () => {
    getUser.mockResolvedValue(null);
    const response = await POST(makeRequest({ entity: "people", action: "workspace", clientId: "client-1" }));
    expect(response.status).toBe(401);
    expect(createPushJob).not.toHaveBeenCalled();
  });

  it("returns 400 for an invalid entity", async () => {
    const response = await POST(makeRequest({ entity: "bogus", action: "workspace", clientId: "client-1" }));
    expect(response.status).toBe(400);
  });

  it("returns 400 for an invalid action", async () => {
    const response = await POST(makeRequest({ entity: "people", action: "bogus", clientId: "client-1" }));
    expect(response.status).toBe(400);
  });

  it("returns 400 when clientId is missing", async () => {
    const response = await POST(makeRequest({ entity: "people", action: "workspace" }));
    expect(response.status).toBe(400);
  });

  it("returns 400 for the campaign action without a campaignId", async () => {
    const response = await POST(makeRequest({ entity: "people", action: "campaign", clientId: "client-1" }));
    expect(response.status).toBe(400);
  });

  it("returns 404 when the client doesn't exist", async () => {
    getClientById.mockResolvedValue(null);
    const response = await POST(makeRequest({ entity: "people", action: "workspace", clientId: "missing" }));
    expect(response.status).toBe(404);
  });

  it("enqueues a people workspace job and returns its id", async () => {
    const response = await POST(
      makeRequest(
        { entity: "people", action: "workspace", clientId: "client-1", existingLeadBehavior: "put" },
        "?niche=widgets"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jobId: "job-abc" });

    expect(createPushJob).toHaveBeenCalledTimes(1);
    const arg = createPushJob.mock.calls[0][0];
    expect(arg).toMatchObject({
      clientId: "client-1",
      platform: "emailbison_people",
      entity: "people",
      action: "workspace",
      campaignId: null,
      niche: ["widgets"],
      triggeredByUserId: "user-1",
      triggeredByEmail: "operator@example.com",
    });
    expect(arg.options.existingLeadBehavior).toBe("put");
    // Parsed filter object stored verbatim, not a re-serialized query string.
    expect(arg.filters).toMatchObject({ niche: { include: ["widgets"] } });
  });

  it("derives platform=emailbison_companies for a companies workspace push", async () => {
    await POST(makeRequest({ entity: "companies", action: "workspace", clientId: "client-1" }));
    expect(createPushJob.mock.calls[0][0]).toMatchObject({
      platform: "emailbison_companies",
      entity: "companies",
    });
  });

  it("derives platform=emailbison_campaign and carries campaignId + parallel for a campaign push", async () => {
    await POST(
      makeRequest({
        entity: "people",
        action: "campaign",
        clientId: "client-1",
        campaignId: "camp-1",
        parallel: true,
      })
    );
    const arg = createPushJob.mock.calls[0][0];
    expect(arg).toMatchObject({ platform: "emailbison_campaign", campaignId: "camp-1" });
    expect(arg.options.parallel).toBe(true);
  });
});
