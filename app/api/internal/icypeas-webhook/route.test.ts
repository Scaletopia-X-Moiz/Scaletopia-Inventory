import { describe, expect, it, vi, beforeEach } from "vitest";
import crypto from "node:crypto";

// Mirrors app/api/internal/push-worker/route.test.ts's mocking style: mock the
// DB write + cache invalidation so this stays a pure-unit test with no live
// Supabase/network dependency (per the task brief's testing convention).
const { updateMock, eqMock, fromMock } = vi.hoisted(() => {
  const eqMock = vi.fn().mockResolvedValue({ error: null });
  const updateMock = vi.fn(() => ({ eq: eqMock }));
  const fromMock = vi.fn(() => ({ update: updateMock }));
  return { updateMock, eqMock, fromMock };
});
vi.mock("@/lib/supabase/admin", () => ({ supabaseAdmin: { from: fromMock } }));

const { invalidatePeopleListCache } = vi.hoisted(() => ({ invalidatePeopleListCache: vi.fn() }));
vi.mock("@/lib/data/people", () => ({ invalidatePeopleListCache }));

const { invalidateCompaniesListCache } = vi.hoisted(() => ({
  invalidateCompaniesListCache: vi.fn(),
}));
vi.mock("@/lib/data/companies", () => ({ invalidateCompaniesListCache }));

const { POST, parseExternalId } = await import("./route");

function req(body: unknown): Request {
  return new Request("http://localhost/api/internal/icypeas-webhook", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

describe("parseExternalId", () => {
  it("parses a valid people/companies externalId", () => {
    expect(parseExternalId("people:abc-123")).toEqual({ table: "people", id: "abc-123" });
    expect(parseExternalId("companies:xyz")).toEqual({ table: "companies", id: "xyz" });
  });

  it("returns null for missing, malformed, or unknown-table externalIds", () => {
    expect(parseExternalId(null)).toBeNull();
    expect(parseExternalId(undefined)).toBeNull();
    expect(parseExternalId("")).toBeNull();
    expect(parseExternalId("no-colon")).toBeNull();
    expect(parseExternalId("widgets:1")).toBeNull();
    expect(parseExternalId("people:")).toBeNull();
    expect(parseExternalId(":123")).toBeNull();
  });
});

describe("POST /api/internal/icypeas-webhook", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updateMock.mockImplementation(() => ({ eq: eqMock }));
    fromMock.mockImplementation(() => ({ update: updateMock }));
    delete process.env.ICYPEAS_API_SECRET;
  });

  it("writes the mapped status for a terminal FOUND item and invalidates the people cache", async () => {
    const res = await POST(
      req({
        data: {
          _id: "abc",
          status: "FOUND",
          results: { emails: [{ email: "a@b.com", certainty: "ultra_sure" }] },
          userData: { externalId: "people:123" },
        },
      })
    );

    expect(res.status).toBe(200);
    expect(fromMock).toHaveBeenCalledWith("people");
    expect(updateMock).toHaveBeenCalledWith(
      expect.objectContaining({ email_status: "ultra_sure" })
    );
    expect(eqMock).toHaveBeenCalledWith("id", "123");
    expect(invalidatePeopleListCache).toHaveBeenCalled();
    expect(invalidateCompaniesListCache).not.toHaveBeenCalled();
  });

  it("routes companies externalIds to the companies table/cache", async () => {
    await POST(
      req({
        data: {
          _id: "abc",
          status: "NOT_FOUND",
          userData: { externalId: "companies:456" },
        },
      })
    );

    expect(fromMock).toHaveBeenCalledWith("companies");
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({ email_status: "not_found" }));
    expect(invalidateCompaniesListCache).toHaveBeenCalled();
  });

  it("skips (no DB write) when the item has no routable externalId", async () => {
    const res = await POST(req({ data: { _id: "abc", status: "FOUND" } }));
    const body = await res.json();
    expect(body.skipped).toBeTruthy();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("skips (no DB write) on an error terminal status (BAD_INPUT/INSUFFICIENT_FUNDS/ABORTED)", async () => {
    for (const status of ["BAD_INPUT", "INSUFFICIENT_FUNDS", "ABORTED"]) {
      fromMock.mockClear();
      const res = await POST(
        req({ data: { _id: "abc", status, userData: { externalId: "people:1" } } })
      );
      const body = await res.json();
      expect(body.skipped).toBeTruthy();
      expect(fromMock).not.toHaveBeenCalled();
    }
  });

  it("skips (no DB write) on a non-terminal status", async () => {
    const res = await POST(
      req({ data: { _id: "abc", status: "IN_PROGRESS", userData: { externalId: "people:1" } } })
    );
    const body = await res.json();
    expect(body.skipped).toBeTruthy();
    expect(fromMock).not.toHaveBeenCalled();
  });

  it("returns 400 on invalid JSON", async () => {
    const res = await POST(
      new Request("http://localhost/api/internal/icypeas-webhook", {
        method: "POST",
        body: "not json",
      })
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when data is missing", async () => {
    const res = await POST(req({}));
    expect(res.status).toBe(400);
  });

  describe("with ICYPEAS_API_SECRET set", () => {
    const secret = "shh";
    const path = "/api/internal/icypeas-webhook";

    beforeEach(() => {
      process.env.ICYPEAS_API_SECRET = secret;
    });

    function sign(timestamp: string): string {
      return crypto.createHmac("sha1", secret).update(`${path}${timestamp}`.toLowerCase()).digest("hex");
    }

    it("accepts a correctly-signed payload", async () => {
      const timestamp = "2023-03-01T04:40:20Z";
      const res = await POST(
        req({
          signature: sign(timestamp),
          timestamp,
          data: { _id: "abc", status: "NOT_FOUND", userData: { externalId: "people:1" } },
        })
      );
      expect(res.status).toBe(200);
    });

    it("rejects a payload with a bad signature (401)", async () => {
      const res = await POST(
        req({
          signature: "deadbeef",
          timestamp: "2023-03-01T04:40:20Z",
          data: { _id: "abc", status: "NOT_FOUND", userData: { externalId: "people:1" } },
        })
      );
      expect(res.status).toBe(401);
      expect(fromMock).not.toHaveBeenCalled();
    });

    it("rejects a payload missing signature/timestamp (401)", async () => {
      const res = await POST(
        req({ data: { _id: "abc", status: "NOT_FOUND", userData: { externalId: "people:1" } } })
      );
      expect(res.status).toBe(401);
    });
  });
});
