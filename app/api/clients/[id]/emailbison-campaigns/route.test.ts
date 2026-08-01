import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { ClientRow } from "@/lib/data/clients";

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ getUser }));

const { getClientById } = vi.hoisted(() => ({ getClientById: vi.fn() }));
vi.mock("@/lib/data/clients", () => ({ getClientById }));

const { getEmailBisonCampaigns } = vi.hoisted(() => ({ getEmailBisonCampaigns: vi.fn() }));
vi.mock("@/lib/emailbison/campaigns", () => ({ getEmailBisonCampaigns }));

const { GET } = await import("@/app/api/clients/[id]/emailbison-campaigns/route");

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
  return new NextRequest("http://localhost/api/clients/client-1/emailbison-campaigns");
}

function makeParams(id = "client-1") {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue(testUser);
  getClientById.mockResolvedValue(testClient);
});

describe("GET /api/clients/[id]/emailbison-campaigns", () => {
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

  it("returns the workspace's campaigns", async () => {
    getEmailBisonCampaigns.mockResolvedValue([{ id: "1", name: "Q3 outreach" }]);
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ campaigns: [{ id: "1", name: "Q3 outreach" }] });
    expect(getEmailBisonCampaigns).toHaveBeenCalledWith({ id: "client-1", apiKey: "key", workspaceId: "ws" });
  });

  it("returns 502 when the EmailBison API call fails", async () => {
    getEmailBisonCampaigns.mockRejectedValue(new Error("boom"));
    const res = await GET(makeRequest(), makeParams());
    expect(res.status).toBe(502);
  });
});
