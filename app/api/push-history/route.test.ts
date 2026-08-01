import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { listPushHistory } = vi.hoisted(() => ({ listPushHistory: vi.fn() }));
vi.mock("@/lib/data/push-history", () => ({ listPushHistory }));

const { GET } = await import("@/app/api/push-history/route");

function makeRequest(query = ""): NextRequest {
  return new NextRequest(`http://localhost/api/push-history${query}`);
}

beforeEach(() => {
  listPushHistory.mockReset();
  listPushHistory.mockResolvedValue({ rows: [], total: 0 });
});

describe("GET /api/push-history", () => {
  it("defaults to no filters and offset 0", async () => {
    await GET(makeRequest());
    expect(listPushHistory).toHaveBeenCalledWith({}, 50, 0);
  });

  it("passes clientId through to the filters", async () => {
    await GET(makeRequest("?clientId=client-1"));
    expect(listPushHistory).toHaveBeenCalledWith({ clientId: "client-1" }, 50, 0);
  });

  it("passes platform through to the filters", async () => {
    await GET(makeRequest("?platform=ghl"));
    expect(listPushHistory).toHaveBeenCalledWith({ platform: "ghl" }, 50, 0);
  });

  it("combines clientId and platform filters", async () => {
    await GET(makeRequest("?clientId=client-1&platform=emailbison&offset=50"));
    expect(listPushHistory).toHaveBeenCalledWith(
      { clientId: "client-1", platform: "emailbison" },
      50,
      50
    );
  });

  it("ignores empty-string filter values", async () => {
    await GET(makeRequest("?clientId=&platform="));
    expect(listPushHistory).toHaveBeenCalledWith({}, 50, 0);
  });
});
