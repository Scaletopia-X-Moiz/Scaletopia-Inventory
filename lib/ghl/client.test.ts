import { describe, expect, it, vi } from "vitest";
import {
  pushContactToGhl,
  requestWithRetry,
  GhlApiError,
  GHL_API_BASE,
  GHL_RETRY_MAX_RETRIES,
  GHL_RETRY_MAX_DELAY_MS,
  type GhlCredentials,
} from "@/lib/ghl/client";

const CREDENTIALS: GhlCredentials = { apiKey: "test-api-key", locationId: "loc_123" };

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: (h: string) => headers[h.toLowerCase()] ?? headers[h] ?? null },
  } as unknown as Response;
}

/** Replace real setTimeout with one that records the requested delay and
 * fires immediately, so retry backoff can be asserted without sleeping. */
function captureRetryDelays() {
  const delays: number[] = [];
  const spy = vi
    .spyOn(globalThis, "setTimeout")
    .mockImplementation(((fn: (...args: unknown[]) => void, delay?: number) => {
      delays.push(delay ?? 0);
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    }) as unknown as typeof setTimeout);
  return { delays, restore: () => spy.mockRestore() };
}

describe("requestWithRetry", () => {
  it("retries a transient status and returns the eventual non-transient response", async () => {
    const { delays, restore } = captureRetryDelays();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(502, { message: "bad gateway" }))
        .mockResolvedValueOnce(jsonResponse(400, { meta: { contactId: "c1" } }));

      const result = await requestWithRetry(fetchImpl, CREDENTIALS, "/contacts/", { email: "a@b.com" });

      expect(result).toEqual({ status: 400, json: { meta: { contactId: "c1" } } });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(delays).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("retries on a network error and succeeds once fetch stops throwing", async () => {
    const { delays, restore } = captureRetryDelays();
    try {
      const fetchImpl = vi
        .fn()
        .mockRejectedValueOnce(new Error("network down"))
        .mockResolvedValueOnce(jsonResponse(200, { ok: true }));

      const result = await requestWithRetry(fetchImpl, CREDENTIALS, "/contacts/", {});

      expect(result).toEqual({ status: 200, json: { ok: true } });
      expect(delays).toHaveLength(1);
    } finally {
      restore();
    }
  });
});

describe("pushContactToGhl", () => {
  it("returns the new contact id on successful creation", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { contact: { id: "contact_1" } }));

    const result = await pushContactToGhl(
      CREDENTIALS,
      { firstName: "Ada", email: "ada@example.com" },
      { fetchImpl }
    );

    expect(result).toEqual({ contactId: "contact_1", deduped: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${GHL_API_BASE}/contacts/`);
    expect(JSON.parse(init.body)).toMatchObject({
      firstName: "Ada",
      email: "ada@example.com",
      locationId: "loc_123",
    });
    expect(init.headers.Authorization).toBe("Bearer test-api-key");
  });

  it("appends tags to the existing contact on a duplicate-contact 400", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(400, {
          message: "duplicate contact",
          meta: { contactId: "existing_contact" },
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, { tags: ["Acme - IoT | 1-10 | US | clay"] }));

    const result = await pushContactToGhl(
      CREDENTIALS,
      { email: "dup@example.com", tags: ["Acme - IoT | 1-10 | US | clay"] },
      { fetchImpl }
    );

    expect(result).toEqual({ contactId: "existing_contact", deduped: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [tagUrl, tagInit] = fetchImpl.mock.calls[1];
    expect(tagUrl).toBe(`${GHL_API_BASE}/contacts/existing_contact/tags`);
    expect(JSON.parse(tagInit.body)).toEqual({ tags: ["Acme - IoT | 1-10 | US | clay"] });
  });

  it("does not call the tags endpoint when the duplicate contact payload has no tags", async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonResponse(400, { meta: { contactId: "existing_contact" } })
    );

    const result = await pushContactToGhl(CREDENTIALS, { email: "dup@example.com" }, { fetchImpl });

    expect(result).toEqual({ contactId: "existing_contact", deduped: true });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries transient 5xx failures and succeeds once the response recovers", async () => {
    const { delays, restore } = captureRetryDelays();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(503, { message: "unavailable" }))
        .mockResolvedValueOnce(jsonResponse(201, { contact: { id: "contact_2" } }));

      const result = await pushContactToGhl(CREDENTIALS, { email: "retry@example.com" }, { fetchImpl });

      expect(result).toEqual({ contactId: "contact_2", deduped: false });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(delays).toHaveLength(1);
    } finally {
      restore();
    }
  });

  it("honors Retry-After on 429 and clamps it to the max delay", async () => {
    const { delays, restore } = captureRetryDelays();
    try {
      const fetchImpl = vi
        .fn()
        .mockResolvedValueOnce(jsonResponse(429, { message: "rate limited" }, { "Retry-After": "9999" }))
        .mockResolvedValueOnce(jsonResponse(201, { contact: { id: "contact_3" } }));

      await pushContactToGhl(CREDENTIALS, { email: "ratelimited@example.com" }, { fetchImpl });

      expect(delays[0]).toBe(GHL_RETRY_MAX_DELAY_MS);
    } finally {
      restore();
    }
  });

  it("gives up after exhausting the retry budget on persistent transient failures", async () => {
    const { restore } = captureRetryDelays();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { message: "down" }));

      await expect(
        pushContactToGhl(CREDENTIALS, { email: "downforever@example.com" }, { fetchImpl })
      ).rejects.toThrow(GhlApiError);

      expect(fetchImpl).toHaveBeenCalledTimes(GHL_RETRY_MAX_RETRIES + 1);
    } finally {
      restore();
    }
  });

  it("surfaces non-transient, non-duplicate failures as errors without retrying", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { message: "invalid api key" }));

    await expect(
      pushContactToGhl(CREDENTIALS, { email: "unauthorized@example.com" }, { fetchImpl })
    ).rejects.toThrow(GhlApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("surfaces a 400 without meta.contactId as an error", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(400, { message: "invalid payload" }));

    await expect(
      pushContactToGhl(CREDENTIALS, { email: "bad-payload@example.com" }, { fetchImpl })
    ).rejects.toThrow(GhlApiError);
  });

  it("throws GhlApiError when the tag-append call fails for a duplicate contact", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(400, { meta: { contactId: "existing_contact" } }))
      .mockResolvedValue(jsonResponse(422, { message: "bad tags" }));

    await expect(
      pushContactToGhl(CREDENTIALS, { email: "dup2@example.com", tags: ["x"] }, { fetchImpl })
    ).rejects.toThrow(GhlApiError);
  });
});
