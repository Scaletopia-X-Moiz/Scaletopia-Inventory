import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { ClientRow } from "@/lib/data/clients";
import { DEFAULT_CAMPAIGN_SETTINGS } from "@/lib/emailbison/campaign-settings";

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ getUser }));

const { getClientById } = vi.hoisted(() => ({ getClientById: vi.fn() }));
vi.mock("@/lib/data/clients", () => ({ getClientById }));

const { getEmailBisonCampaigns, createEmailBisonCampaign } = vi.hoisted(() => ({
  getEmailBisonCampaigns: vi.fn(),
  createEmailBisonCampaign: vi.fn(),
}));
vi.mock("@/lib/emailbison/campaigns", () => ({ getEmailBisonCampaigns, createEmailBisonCampaign }));

const { GET, POST } = await import("@/app/api/clients/[id]/emailbison-campaigns/route");

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

const testPostBody = {
  name: "Q4 outreach",
  senderEmailIds: ["sender-1"],
  schedule: {
    timezone: "America/New_York",
    days: ["monday"],
    startTime: "09:00",
    endTime: "17:00",
  },
  sequenceSteps: [{ subject: "Hello", body: "Hi there" }],
  launch: true,
};

function makePostRequest(body: unknown = testPostBody): NextRequest {
  return new NextRequest("http://localhost/api/clients/client-1/emailbison-campaigns", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

describe("POST /api/clients/[id]/emailbison-campaigns", () => {
  it("returns 401 when there is no session", async () => {
    getUser.mockResolvedValue(null);
    const res = await POST(makePostRequest(), makeParams());
    expect(res.status).toBe(401);
  });

  it("returns 404 when the client has no EmailBison credentials", async () => {
    getClientById.mockResolvedValue({ ...testClient, emailbisonApiKey: null });
    const res = await POST(makePostRequest(), makeParams());
    expect(res.status).toBe(404);
  });

  it("returns 404 when the client doesn't exist", async () => {
    getClientById.mockResolvedValue(null);
    const res = await POST(makePostRequest(), makeParams());
    expect(res.status).toBe(404);
  });

  it("creates the campaign and returns it", async () => {
    const createdCampaign = { id: "1", name: "Q4 outreach" };
    createEmailBisonCampaign.mockResolvedValue(createdCampaign);
    const res = await POST(makePostRequest(), makeParams());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ campaign: createdCampaign });
    expect(createEmailBisonCampaign).toHaveBeenCalledWith(
      { id: "client-1", apiKey: "key", workspaceId: "ws" },
      {
        name: testPostBody.name,
        senderEmailIds: testPostBody.senderEmailIds,
        schedule: testPostBody.schedule,
        steps: testPostBody.sequenceSteps,
        settings: undefined,
        launch: testPostBody.launch,
      }
    );
  });

  it("forwards parsed settings to the orchestrator", async () => {
    createEmailBisonCampaign.mockResolvedValue({ id: "1", name: "Q4 outreach" });
    const settings = { maxEmailsPerDay: 50, maxNewLeadsPerDay: 20, plainText: true, openTracking: true };
    const res = await POST(makePostRequest({ ...testPostBody, settings }), makeParams());
    expect(res.status).toBe(200);
    expect(createEmailBisonCampaign.mock.calls.at(-1)?.[1].settings).toEqual({
      ...DEFAULT_CAMPAIGN_SETTINGS,
      ...settings,
    });
  });

  it("forwards the new settings fields and rejects invalid ones", async () => {
    createEmailBisonCampaign.mockResolvedValue({ id: "1", name: "Q4 outreach" });
    const settings = {
      includeAutoRepliesInStats: false,
      maxSendsPerReceivingDomain: 40,
      sequencePrioritization: "new_leads",
    };
    const ok = await POST(makePostRequest({ ...testPostBody, settings }), makeParams());
    expect(ok.status).toBe(200);
    expect(createEmailBisonCampaign.mock.calls.at(-1)?.[1].settings).toEqual({ ...DEFAULT_CAMPAIGN_SETTINGS, ...settings });

    createEmailBisonCampaign.mockClear();
    for (const bad of [{ maxSendsPerReceivingDomain: 1001 }, { sequencePrioritization: "x" }]) {
      const res = await POST(makePostRequest({ ...testPostBody, settings: bad }), makeParams());
      expect(res.status).toBe(400);
    }
    expect(createEmailBisonCampaign).not.toHaveBeenCalled();
  });

  it("returns 400 without calling EmailBison when settings are invalid", async () => {
    createEmailBisonCampaign.mockClear();
    const res = await POST(makePostRequest({ ...testPostBody, settings: { maxEmailsPerDay: 0 } }), makeParams());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Invalid campaign settings");
    expect(createEmailBisonCampaign).not.toHaveBeenCalled();
  });

  it("returns 502 with the step-specific message when the orchestrator fails", async () => {
    createEmailBisonCampaign.mockRejectedValue(new Error("Campaign created but attaching senders failed: boom"));
    const res = await POST(makePostRequest(), makeParams());
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body).toEqual({ error: "Campaign created but attaching senders failed: boom" });
  });
});
