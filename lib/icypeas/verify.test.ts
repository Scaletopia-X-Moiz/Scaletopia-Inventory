import crypto from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  firstEmail,
  submitEmailVerification,
  fetchResult,
  pollUntilTerminal,
  mapCertainty,
  verifyWebhookSignature,
  submitBulkEmailVerification,
  readBulkResults,
  mapBulkItem,
  EMAIL_STATUSES,
  type RawItem,
} from "@/lib/icypeas/verify";

function jsonFetch(body: unknown, ok = true, statusCode = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status: statusCode,
    json: async () => body,
  }) as unknown as typeof fetch;
}

/** A sequence of canned responses, one per call — used to simulate a poll
 * loop progressing from NONE -> IN_PROGRESS -> a terminal status. */
function sequenceFetch(bodies: unknown[]): typeof fetch {
  const fn = vi.fn();
  for (const body of bodies) {
    fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => body });
  }
  return fn as unknown as typeof fetch;
}

const apiKey = "test-key";

describe("firstEmail", () => {
  it("returns null for empty/nullish input", () => {
    expect(firstEmail(null)).toBeNull();
    expect(firstEmail(undefined)).toBeNull();
    expect(firstEmail("")).toBeNull();
    expect(firstEmail("  ")).toBeNull();
    expect(firstEmail(",,")).toBeNull();
  });

  it("takes the first address from a comma-separated list and trims it", () => {
    expect(firstEmail("a@x.com")).toBe("a@x.com");
    expect(firstEmail(" a@x.com , b@x.com ")).toBe("a@x.com");
  });
});

describe("submitEmailVerification", () => {
  it("returns the item id on a successful ack", async () => {
    const fetchImpl = jsonFetch({
      success: true,
      item: { _id: "kMnquYkBTs8kZM9ND26h", status: "NONE" },
    });

    const result = await submitEmailVerification("someone@acme.com", { deps: { fetchImpl, apiKey } });
    expect(result).toEqual({ id: "kMnquYkBTs8kZM9ND26h" });
  });

  it("sends the api key header, email body, and optional custom externalId/webhookUrl", async () => {
    const fetchImpl = jsonFetch({ success: true, item: { _id: "abc", status: "NONE" } });

    await submitEmailVerification("someone@acme.com", {
      externalId: "people:123",
      webhookUrl: "https://example.com/webhook",
      deps: { fetchImpl, apiKey },
    });

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://app.icypeas.com/api/email-verification");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(apiKey);
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      email: "someone@acme.com",
      custom: { externalId: "people:123", webhookUrl: "https://example.com/webhook" },
    });
  });

  it("omits `custom` entirely when no externalId/webhookUrl given", async () => {
    const fetchImpl = jsonFetch({ success: true, item: { _id: "abc", status: "NONE" } });
    await submitEmailVerification("someone@acme.com", { deps: { fetchImpl, apiKey } });
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body).toEqual({ email: "someone@acme.com" });
  });

  it("throws when the ack reports an error", async () => {
    const fetchImpl = jsonFetch({ success: false, error: "Invalid API key" });
    await expect(
      submitEmailVerification("someone@acme.com", { deps: { fetchImpl, apiKey } })
    ).rejects.toThrow(/Invalid API key/);
  });

  it("throws when no item id comes back", async () => {
    const fetchImpl = jsonFetch({ success: true, item: { status: "NONE" } });
    await expect(
      submitEmailVerification("someone@acme.com", { deps: { fetchImpl, apiKey } })
    ).rejects.toThrow(/did not return an item id/);
  });

  it("throws on a non-200 HTTP response", async () => {
    const fetchImpl = jsonFetch({}, false, 401);
    await expect(
      submitEmailVerification("someone@acme.com", { deps: { fetchImpl, apiKey } })
    ).rejects.toThrow(/HTTP 401/);
  });

  it("throws when no api key is available", async () => {
    const fetchImpl = jsonFetch({ item: { _id: "abc" } });
    await expect(
      submitEmailVerification("someone@acme.com", { deps: { fetchImpl, apiKey: "" } })
    ).rejects.toThrow(/ICYPEAS_API_KEY/);
  });

  it("throws when the email is blank", async () => {
    const fetchImpl = jsonFetch({ item: { _id: "abc" } });
    await expect(
      submitEmailVerification("   ", { deps: { fetchImpl, apiKey } })
    ).rejects.toThrow(/No email/);
  });
});

describe("fetchResult", () => {
  const rawItem: RawItem = {
    _id: "oSmI5YYBMa6Snk9TvjDA",
    status: "FOUND",
    results: {
      emails: [{ email: "example-email@icypeas.com", certainty: "ultra_sure" }],
    },
    userData: { externalId: "people:123" },
  };

  it("unwraps an `{ item }` envelope", async () => {
    const fetchImpl = jsonFetch({ success: true, item: rawItem });
    const result = await fetchResult("oSmI5YYBMa6Snk9TvjDA", { fetchImpl, apiKey });
    expect(result).toEqual(rawItem);
  });

  it("unwraps an `{ items: [...] }` envelope", async () => {
    const fetchImpl = jsonFetch({ success: true, items: [rawItem] });
    const result = await fetchResult("oSmI5YYBMa6Snk9TvjDA", { fetchImpl, apiKey });
    expect(result).toEqual(rawItem);
  });

  it("accepts a bare item with no envelope", async () => {
    const fetchImpl = jsonFetch(rawItem);
    const result = await fetchResult("oSmI5YYBMa6Snk9TvjDA", { fetchImpl, apiKey });
    expect(result).toEqual(rawItem);
  });

  it("sends the id in the POST body", async () => {
    const fetchImpl = jsonFetch({ item: rawItem });
    await fetchResult("oSmI5YYBMa6Snk9TvjDA", { fetchImpl, apiKey });
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://app.icypeas.com/api/bulk-single-searchs/read");
    expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual({
      id: "oSmI5YYBMa6Snk9TvjDA",
    });
  });

  it("throws when no item can be found in the response", async () => {
    const fetchImpl = jsonFetch({ success: true });
    await expect(fetchResult("missing", { fetchImpl, apiKey })).rejects.toThrow(/no item/);
  });
});

describe("mapCertainty", () => {
  it("maps every certainty token to itself (they equal our EMAIL_STATUSES)", () => {
    for (const certainty of ["ultra_sure", "very_sure", "probable", "undeliverable", "not_found"]) {
      const item: RawItem = {
        status: "FOUND",
        results: { emails: [{ email: "x@y.com", certainty }] },
      };
      const mapped = mapCertainty(item);
      expect(mapped).toEqual({ status: certainty, terminal: true, certainty, email: "x@y.com" });
      expect(EMAIL_STATUSES.has(mapped.status!)).toBe(true);
    }
  });

  it("maps DEBITED like FOUND", () => {
    const item: RawItem = {
      status: "DEBITED",
      results: { emails: [{ email: "x@y.com", certainty: "very_sure" }] },
    };
    expect(mapCertainty(item)).toEqual({
      status: "very_sure",
      terminal: true,
      certainty: "very_sure",
      email: "x@y.com",
    });
  });

  it("maps NOT_FOUND / DEBITED_NOT_FOUND to not_found", () => {
    for (const status of ["NOT_FOUND", "DEBITED_NOT_FOUND"]) {
      expect(mapCertainty({ status })).toEqual({
        status: "not_found",
        terminal: true,
        certainty: "not_found",
        email: null,
      });
    }
  });

  it("treats FOUND with no usable email/certainty as not_found", () => {
    const item: RawItem = { status: "FOUND", results: { emails: [] } };
    expect(mapCertainty(item)).toEqual({
      status: "not_found",
      terminal: true,
      certainty: null,
      email: null,
    });
  });

  it("marks BAD_INPUT / INSUFFICIENT_FUNDS / ABORTED as terminal with no status (error)", () => {
    for (const status of ["BAD_INPUT", "INSUFFICIENT_FUNDS", "ABORTED"]) {
      expect(mapCertainty({ status })).toEqual({
        status: null,
        terminal: true,
        certainty: null,
        email: null,
      });
    }
  });

  it("marks NONE / SCHEDULED / IN_PROGRESS (and unknown tokens) as non-terminal", () => {
    for (const status of ["NONE", "SCHEDULED", "IN_PROGRESS", "SOME_FUTURE_STATUS", ""]) {
      expect(mapCertainty({ status })).toEqual({
        status: null,
        terminal: false,
        certainty: null,
        email: null,
      });
    }
  });
});

describe("pollUntilTerminal", () => {
  it("polls until a terminal status and maps the result", async () => {
    const fetchImpl = sequenceFetch([
      { item: { _id: "x", status: "NONE" } },
      { item: { _id: "x", status: "IN_PROGRESS" } },
      {
        item: {
          _id: "x",
          status: "FOUND",
          results: { emails: [{ email: "a@b.com", certainty: "probable" }] },
        },
      },
    ]);

    const result = await pollUntilTerminal("x", {
      deps: { fetchImpl, apiKey },
      intervalMs: 0,
      timeoutMs: 5000,
      email: "a@b.com",
    });

    expect(result).toEqual({
      email: "a@b.com",
      status: "probable",
      certainty: "probable",
      credits: null,
    });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(3);
  });

  it("throws on an error terminal status (INSUFFICIENT_FUNDS)", async () => {
    const fetchImpl = jsonFetch({ item: { _id: "x", status: "INSUFFICIENT_FUNDS" } });
    await expect(
      pollUntilTerminal("x", { deps: { fetchImpl, apiKey }, intervalMs: 0, email: "a@b.com" })
    ).rejects.toThrow(/INSUFFICIENT_FUNDS/);
  });

  it("throws on timeout when the item never reaches a terminal status", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ item: { _id: "x", status: "IN_PROGRESS" } }),
    }) as unknown as typeof fetch;

    await expect(
      pollUntilTerminal("x", {
        deps: { fetchImpl, apiKey },
        intervalMs: 1,
        timeoutMs: 5,
        email: "a@b.com",
      })
    ).rejects.toThrow(/timed out/);
  });
});

describe("submitBulkEmailVerification", () => {
  it("posts task/name/data/custom.externalIds and returns the file id", async () => {
    const fetchImpl = jsonFetch({ success: true, file: "FILE123", status: "in_progress" });

    const result = await submitBulkEmailVerification(
      [
        { email: "a@x.com", externalId: "people:1" },
        { email: "b@x.com", externalId: "people:2" },
      ],
      { fetchImpl, apiKey }
    );

    expect(result).toEqual({ files: ["FILE123"] });

    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call[0]).toBe("https://app.icypeas.com/api/bulk-search");
    const init = call[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(apiKey);
    const body = JSON.parse(init.body as string);
    expect(body.task).toBe("email-verification");
    expect(body.data).toEqual([["a@x.com"], ["b@x.com"]]);
    expect(body.custom).toEqual({ externalIds: ["people:1", "people:2"] });
  });

  it("returns an empty file list and makes no call when there are no valid rows", async () => {
    const fetchImpl = jsonFetch({ success: true, file: "FILE123" });
    const result = await submitBulkEmailVerification([{ email: "  ", externalId: "people:1" }], {
      fetchImpl,
      apiKey,
    });
    expect(result).toEqual({ files: [] });
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(0);
  });

  it("chunks at 5000 rows/call and submits multiple chunks", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string);
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, file: `FILE-${body.data.length}` }),
      };
    }) as unknown as typeof fetch;

    const rows = Array.from({ length: 5001 }, (_, i) => ({
      email: `person${i}@x.com`,
      externalId: `people:${i}`,
    }));

    const result = await submitBulkEmailVerification(rows, { fetchImpl, apiKey });

    expect(result.files.length).toBe(2);
    expect((fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);
  }, 10000);

  it("throws on a non-success ack", async () => {
    const fetchImpl = jsonFetch({ success: false, error: "bad request" });
    await expect(
      submitBulkEmailVerification([{ email: "a@x.com", externalId: "people:1" }], {
        fetchImpl,
        apiKey,
      })
    ).rejects.toThrow(/bad request/);
  });

  it("throws when no file id comes back", async () => {
    const fetchImpl = jsonFetch({ success: true });
    await expect(
      submitBulkEmailVerification([{ email: "a@x.com", externalId: "people:1" }], {
        fetchImpl,
        apiKey,
      })
    ).rejects.toThrow(/did not return a file id/);
  });
});

describe("readBulkResults", () => {
  const itemA: RawItem = {
    _id: "1",
    status: "FOUND",
    order: 0,
    results: { emails: [{ email: "a@x.com", certainty: "ultra_sure" }] },
    userData: { externalId: "people:1" },
  };
  const itemB: RawItem = {
    _id: "2",
    status: "IN_PROGRESS",
    order: 1,
    userData: { externalId: "people:2" },
  };

  it("returns items + total + sorts from a full page (hasMore)", async () => {
    const fetchImpl = jsonFetch({
      success: true,
      items: Array.from({ length: 100 }, (_, i) => ({ ...itemA, _id: String(i), order: i })),
      sorts: ["cursor-1"],
      total: 250,
    });

    const page = await readBulkResults("FILE123", { limit: 100, deps: { fetchImpl, apiKey } });
    expect(page.items.length).toBe(100);
    expect(page.sorts).toEqual(["cursor-1"]);
    expect(page.total).toBe(250);
  });

  it("pages using next/sorts and stops when a short page comes back", async () => {
    const fetchImpl = vi.fn();
    (fetchImpl as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          items: [itemA, itemB],
          sorts: ["cursor-1"],
          total: 3,
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          items: [{ ...itemA, _id: "3", order: 2, userData: { externalId: "people:3" } }],
          sorts: null,
          total: 3,
        }),
      });

    const page1 = await readBulkResults("FILE123", {
      limit: 2,
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch, apiKey },
    });
    expect(page1.items.length).toBe(2);
    expect(page1.sorts).toEqual(["cursor-1"]);
    expect(page1.total).toBe(3);

    const page2 = await readBulkResults("FILE123", {
      limit: 2,
      next: true,
      sorts: page1.sorts ?? undefined,
      deps: { fetchImpl: fetchImpl as unknown as typeof fetch, apiKey },
    });
    expect(page2.items.length).toBe(1);
    expect(page2.sorts).toBeNull(); // short page -> treated as last page

    const firstCallBody = JSON.parse(
      (fetchImpl.mock.calls[0][1] as RequestInit).body as string
    );
    expect(firstCallBody).toEqual({ mode: "bulk", file: "FILE123", limit: 2 });

    const secondCallBody = JSON.parse(
      (fetchImpl.mock.calls[1][1] as RequestInit).body as string
    );
    expect(secondCallBody).toEqual({
      mode: "bulk",
      file: "FILE123",
      limit: 2,
      next: true,
      sorts: ["cursor-1"],
    });
  });

  it("caps limit at 100", async () => {
    const fetchImpl = jsonFetch({ success: true, items: [], sorts: null, total: 0 });
    await readBulkResults("FILE123", { limit: 500, deps: { fetchImpl, apiKey } });
    const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((call[1] as RequestInit).body as string);
    expect(body.limit).toBe(100);
  });
});

describe("mapBulkItem", () => {
  it("maps a terminal FOUND item with externalId/order/certainty", () => {
    const item: RawItem = {
      status: "FOUND",
      order: 4,
      results: { emails: [{ email: "a@x.com", certainty: "probable" }] },
      userData: { externalId: "companies:9" },
    };
    expect(mapBulkItem(item)).toEqual({
      externalId: "companies:9",
      order: 4,
      status: "probable",
      terminal: true,
      certainty: "probable",
    });
  });

  it("marks a non-terminal item accordingly, still surfacing externalId/order", () => {
    const item: RawItem = { status: "IN_PROGRESS", order: 1, userData: { externalId: "people:2" } };
    expect(mapBulkItem(item)).toEqual({
      externalId: "people:2",
      order: 1,
      status: null,
      terminal: false,
      certainty: null,
    });
  });

  it("marks an error status as terminal with a null status (no throw)", () => {
    const item: RawItem = { status: "INSUFFICIENT_FUNDS", userData: { externalId: "people:3" } };
    expect(mapBulkItem(item)).toEqual({
      externalId: "people:3",
      order: null,
      status: null,
      terminal: true,
      certainty: null,
    });
  });
});

describe("verifyWebhookSignature", () => {
  const path = "/api/internal/icypeas-webhook";
  const timestamp = "2023-03-01T04:40:20Z";
  const secret = "shh-its-a-secret";

  function sign(p: string, t: string, s: string): string {
    return crypto.createHmac("sha1", s).update(`${p}${t}`.toLowerCase()).digest("hex");
  }

  it("accepts a correctly-signed payload", () => {
    const signature = sign(path, timestamp, secret);
    expect(verifyWebhookSignature(path, timestamp, signature, secret)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    expect(verifyWebhookSignature(path, timestamp, "deadbeef".repeat(3), secret)).toBe(false);
  });

  it("rejects when the secret used to verify differs from the one used to sign", () => {
    const signature = sign(path, timestamp, secret);
    expect(verifyWebhookSignature(path, timestamp, signature, "wrong-secret")).toBe(false);
  });

  it("returns false (not throw) on empty inputs", () => {
    expect(verifyWebhookSignature(path, "", "sig", secret)).toBe(false);
    expect(verifyWebhookSignature(path, timestamp, "", secret)).toBe(false);
    expect(verifyWebhookSignature(path, timestamp, "sig", "")).toBe(false);
  });
});
