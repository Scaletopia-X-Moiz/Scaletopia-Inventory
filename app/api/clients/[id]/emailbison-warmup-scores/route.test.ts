import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { ClientRow } from "@/lib/data/clients";

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ getUser }));

const { getClientById } = vi.hoisted(() => ({ getClientById: vi.fn() }));
vi.mock("@/lib/data/clients", () => ({ getClientById }));

const { listAllWarmupSenderEmails } = vi.hoisted(() => ({ listAllWarmupSenderEmails: vi.fn() }));
vi.mock("@/lib/emailbison/client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/emailbison/client")>("@/lib/emailbison/client");
  return { ...actual, listAllWarmupSenderEmails };
});

const { GET } = await import("@/app/api/clients/[id]/emailbison-warmup-scores/route");

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

function makeRequest(): NextRequest {
  return new NextRequest("http://localhost/api/clients/client-1/emailbison-warmup-scores");
}

function makeParams(id = "client-1") {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue(testUser);
  getClientById.mockResolvedValue(testClient);
});

describe("GET /api/clients/[id]/emailbison-warmup-scores", () => {
  it("returns 401 when there is no session", async () => {
    getUser.mockResolvedValue(null);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 404 when the client has no EmailBison credentials", async () => {
    getClientById.mockResolvedValue({ ...testClient, emailbisonApiKey: null });
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 404 when the client doesn't exist", async () => {
    getClientById.mockResolvedValue(null);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns the workspace's warmup stats", async () => {
    listAllWarmupSenderEmails.mockResolvedValue([
      {
        id: "1",
        warmupScore: 92,
        warmupEnabled: null,
        bouncesReceived: 0,
        bouncesCaused: 0,
        disabledForBouncing: 0,
      },
    ]);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      warmupStats: [
        {
          id: "1",
          warmupScore: 92,
          warmupEnabled: null,
          bouncesReceived: 0,
          bouncesCaused: 0,
          disabledForBouncing: 0,
        },
      ],
    });
    expect(listAllWarmupSenderEmails).toHaveBeenCalledWith({ apiKey: "key", workspaceId: "ws" });
  });

  it("returns 502 when the EmailBison API call fails", async () => {
    listAllWarmupSenderEmails.mockRejectedValue(new Error("boom"));
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(502);
  });
});
