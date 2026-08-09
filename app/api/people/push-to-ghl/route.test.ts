import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { ClientRow } from "@/lib/data/clients";

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ getUser }));

const { getClientById } = vi.hoisted(() => ({ getClientById: vi.fn() }));
vi.mock("@/lib/data/clients", () => ({ getClientById }));

const { createPushJob } = vi.hoisted(() => ({ createPushJob: vi.fn() }));
vi.mock("@/lib/data/push-jobs", () => ({ createPushJob }));

vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: vi.fn() };
});

const { POST } = await import("@/app/api/people/push-to-ghl/route");

const testUser = { id: "user-1", email: "operator@example.com" };
const testClient: ClientRow = {
  id: "client-1",
  slug: "acme",
  name: "Acme",
  ghlApiKey: "k",
  ghlLocationId: "loc",
  emailbisonApiKey: null,
  emailbisonWorkspaceId: null,
  isActive: true,
  updatedAt: new Date().toISOString(),
};

function makeRequest(body: unknown, query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/people/push-to-ghl${query}`, {
    method: "POST",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue(testUser);
  getClientById.mockResolvedValue(testClient);
  createPushJob.mockResolvedValue({ id: "job-ghl" });
});

describe("POST /api/people/push-to-ghl (enqueue-only)", () => {
  it("returns 401 when there is no session", async () => {
    getUser.mockResolvedValue(null);
    const response = await POST(makeRequest({ clientId: "client-1" }));
    expect(response.status).toBe(401);
    expect(createPushJob).not.toHaveBeenCalled();
  });

  it("returns 400 when clientId is missing", async () => {
    const response = await POST(makeRequest({}));
    expect(response.status).toBe(400);
  });

  it("returns 404 when the client doesn't exist", async () => {
    getClientById.mockResolvedValue(null);
    const response = await POST(makeRequest({ clientId: "missing" }));
    expect(response.status).toBe(404);
  });

  it("enqueues a ghl people job with derived niche/options and returns its id", async () => {
    const response = await POST(
      makeRequest(
        { clientId: "client-1", customTagSuffix: "leadership", standardFieldMapping: null },
        "?niche=widgets&niche=gadgets"
      )
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jobId: "job-ghl" });

    const arg = createPushJob.mock.calls[0][0];
    expect(arg).toMatchObject({
      clientId: "client-1",
      platform: "ghl",
      entity: "people",
      action: null,
      campaignId: null,
      niche: ["widgets", "gadgets"],
      triggeredByUserId: "user-1",
      triggeredByEmail: "operator@example.com",
    });
    expect(arg.options.customTagSuffix).toBe("leadership");
    expect(arg.filters).toMatchObject({ niche: { include: ["widgets", "gadgets"] } });
  });

  it("upgrades a legacy-shaped fieldMapping entry instead of dropping it (ticket #142)", async () => {
    const response = await POST(
      makeRequest({
        clientId: "client-1",
        fieldMapping: [{ virtualColumnKey: "lead_score", ghlFieldId: "f1" }],
      })
    );

    expect(response.status).toBe(200);
    const arg = createPushJob.mock.calls[0][0];
    expect(arg.options.fieldMapping).toEqual([{ ghlFieldId: "f1", source: "column", columnKey: "lead_score" }]);
  });

  it("accepts a current-shaped literal fieldMapping entry", async () => {
    const response = await POST(
      makeRequest({
        clientId: "client-1",
        fieldMapping: [{ ghlFieldId: "f2", source: "literal", value: "static" }],
      })
    );

    expect(response.status).toBe(200);
    const arg = createPushJob.mock.calls[0][0];
    expect(arg.options.fieldMapping).toEqual([{ ghlFieldId: "f2", source: "literal", value: "static" }]);
  });
});
