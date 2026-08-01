import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { ClientRow } from "@/lib/data/clients";

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ getUser }));

const { getClientById } = vi.hoisted(() => ({ getClientById: vi.fn() }));
vi.mock("@/lib/data/clients", () => ({ getClientById }));

const { logActivity } = vi.hoisted(() => ({ logActivity: vi.fn() }));
vi.mock("@/lib/activity/log", () => ({ logActivity }));

const {
  runPeopleAddToEmailBison,
  runCompaniesAddToEmailBison,
  runPeopleAddToCampaign,
  runCompaniesAddToCampaign,
} = vi.hoisted(() => ({
  runPeopleAddToEmailBison: vi.fn(),
  runCompaniesAddToEmailBison: vi.fn(),
  runPeopleAddToCampaign: vi.fn(),
  runCompaniesAddToCampaign: vi.fn(),
}));
vi.mock("@/lib/emailbison/push-to-emailbison", () => ({
  runPeopleAddToEmailBison,
  runCompaniesAddToEmailBison,
  runPeopleAddToCampaign,
  runCompaniesAddToCampaign,
}));

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

async function readSseEvents(response: Response): Promise<Record<string, unknown>[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice("data: ".length)));
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue(testUser);
  getClientById.mockResolvedValue(testClient);
});

describe("POST /api/emailbison/push", () => {
  it("returns 401 when there is no session", async () => {
    getUser.mockResolvedValue(null);

    const response = await POST(makeRequest({ entity: "people", action: "workspace", clientId: "client-1" }));

    expect(response.status).toBe(401);
    expect(runPeopleAddToEmailBison).not.toHaveBeenCalled();
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

  it("dispatches Add-to-EmailBison for entity=people, streaming progress and a done event", async () => {
    runPeopleAddToEmailBison.mockImplementation(async (_filters, _client, _user, deps) => {
      deps.onProgress?.({ phase: "resolving", done: 0, total: 0, pushed: 0, errors: 0 });
      deps.onProgress?.({ phase: "done", done: 2, total: 2, pushed: 2, errors: 0 });
      return { total_matched: 2, pushed: 2, errors: 0, failed_people: [] };
    });

    const response = await POST(
      makeRequest(
        { entity: "people", action: "workspace", clientId: "client-1", existingLeadBehavior: "put" },
        "?niche=widgets"
      )
    );

    expect(response.status).toBe(200);
    expect(runPeopleAddToEmailBison).toHaveBeenCalledTimes(1);
    expect(runCompaniesAddToEmailBison).not.toHaveBeenCalled();
    const [, client, user, deps] = runPeopleAddToEmailBison.mock.calls[0];
    expect(client).toBe(testClient);
    expect(user).toBe(testUser);
    expect(deps.existingLeadBehavior).toBe("put");

    const events = await readSseEvents(response);
    expect(events[0]).toMatchObject({ type: "progress", phase: "resolving" });
    expect(events.at(-1)).toMatchObject({
      type: "done",
      action: "workspace",
      result: { total_matched: 2, pushed: 2, errors: 0 },
    });
    expect((events.at(-1) as { note: string }).note).toMatch(/created or updated/i);
    expect(logActivity).toHaveBeenCalledWith(
      "emailbison.push",
      expect.objectContaining({ target: "people", action: "workspace", pushed: 2 }),
      testUser
    );
  });

  it("dispatches Add-to-Campaign for entity=companies with campaignId and parallel", async () => {
    runCompaniesAddToCampaign.mockImplementation(async (_filters, _client, campaignId, _user, deps) => {
      deps.onProgress?.({ phase: "attaching", done: 0, total: 3, attached: 0, errors: 0 });
      return { total_matched: 3, attached: 3, errors: 0, failed_people: [] };
    });

    const response = await POST(
      makeRequest({
        entity: "companies",
        action: "campaign",
        clientId: "client-1",
        campaignId: "camp-1",
        parallel: true,
      })
    );

    expect(response.status).toBe(200);
    expect(runCompaniesAddToCampaign).toHaveBeenCalledTimes(1);
    expect(runPeopleAddToCampaign).not.toHaveBeenCalled();
    const [, , campaignId, user, deps] = runCompaniesAddToCampaign.mock.calls[0];
    expect(campaignId).toBe("camp-1");
    expect(user).toBe(testUser);
    expect(deps.parallel).toBe(true);

    const events = await readSseEvents(response);
    expect(events.at(-1)).toMatchObject({
      type: "done",
      action: "campaign",
      result: { total_matched: 3, attached: 3, errors: 0 },
    });
    expect((events.at(-1) as { note: string }).note).toMatch(/queued/i);
  });

  it("streams an error event and logs a failed activity when the orchestrator throws", async () => {
    runPeopleAddToEmailBison.mockImplementation(async (_filters, _client, _user, deps) => {
      deps.onProgress?.({ phase: "pushing", done: 1, total: 5, pushed: 1, errors: 0 });
      throw new Error('Client "Acme" has no EmailBison credentials configured');
    });

    const response = await POST(makeRequest({ entity: "people", action: "workspace", clientId: "client-1" }));

    const events = await readSseEvents(response);
    expect(events.at(-1)).toMatchObject({
      type: "error",
      message: 'Client "Acme" has no EmailBison credentials configured',
    });
    expect(logActivity).toHaveBeenCalledWith(
      "emailbison.push",
      expect.objectContaining({ failed: true, done: 1, total: 5 }),
      testUser
    );
  });
});
