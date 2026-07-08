import { describe, expect, it, vi } from "vitest";
import { cleanCompanyName, RATE_LIMIT_MAX_DELAY_MS } from "@/lib/clean-names/clean-names";

const FAKE_API_KEY = "sk-or-v1-test";

function openRouterFetch(brandName: string, ok = true, status = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    headers: { get: () => null },
    json: async () => ({
      choices: [{ message: { content: JSON.stringify({ formattedCompanyName: brandName }) } }],
    }),
    text: async () => "",
  }) as unknown as typeof fetch;
}

describe("cleanCompanyName", () => {
  it("returns the parsed formattedCompanyName on success", async () => {
    const fetchImpl = openRouterFetch("Packer");
    const result = await cleanCompanyName("PACKER", "packer.com", {
      fetchImpl,
      apiKey: FAKE_API_KEY,
    });
    expect(result).toBe("Packer");
  });

  it("sends the auth header, model, response_format, and plugins", async () => {
    const fetchImpl = openRouterFetch("Packer");
    await cleanCompanyName("PACKER", "packer.com", { fetchImpl, apiKey: FAKE_API_KEY });

    const mockFetch = fetchImpl as unknown as ReturnType<typeof vi.fn>;
    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(init.headers.Authorization).toBe(`Bearer ${FAKE_API_KEY}`);
    expect(init.headers["Content-Type"]).toBe("application/json");

    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("google/gemini-2.5-flash-lite");
    expect(body.messages[0].role).toBe("user");
    expect(body.messages[0].content).toContain("PACKER");
    expect(body.messages[0].content).toContain("packer.com");
    expect(body.response_format).toEqual({
      type: "json_schema",
      json_schema: {
        name: "company_name_formatting",
        strict: true,
        schema: {
          type: "object",
          properties: {
            formattedCompanyName: {
              type: "string",
              description: "The cleaned, simplified brand name",
            },
          },
          required: ["formattedCompanyName"],
          additionalProperties: false,
        },
      },
    });
    expect(body.plugins).toEqual([{ id: "response-healing" }]);
  });

  it("throws when no API key is available", async () => {
    const fetchImpl = openRouterFetch("Packer");
    await expect(
      cleanCompanyName("PACKER", "packer.com", { fetchImpl, apiKey: "" })
    ).rejects.toThrow(/OPENROUTER_API_KEY/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws immediately (no retry) on a hard failure status like 402", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      headers: { get: () => null },
      text: async () => "Payment required",
    }) as unknown as typeof fetch;

    await expect(
      cleanCompanyName("PACKER", "packer.com", { fetchImpl, apiKey: FAKE_API_KEY })
    ).rejects.toThrow(/402/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("throws when OpenRouter returns no brand name", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({ formattedCompanyName: "" }) } }],
      }),
      text: async () => "",
    }) as unknown as typeof fetch;

    await expect(
      cleanCompanyName("PACKER", "packer.com", { fetchImpl, apiKey: FAKE_API_KEY })
    ).rejects.toThrow(/no brand name/);
  });

  describe("429 Retry-After handling", () => {
    /** Replace the real setTimeout with one that records the requested delay
     * and fires the callback immediately, so we can assert what the retry
     * *would* have waited without actually sleeping. Adapted from
     * push-to-clay.test.ts's rate-limit tests. */
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

    function headers(retryAfter: string) {
      return { get: (h: string) => (h.toLowerCase() === "retry-after" ? retryAfter : null) };
    }

    it("clamps an absurd Retry-After to RATE_LIMIT_MAX_DELAY_MS then succeeds", async () => {
      const { delays, restore } = captureRetryDelays();
      let call = 0;
      const fetchImpl = vi.fn(async () => {
        call++;
        if (call === 1) {
          return {
            ok: false,
            status: 429,
            headers: headers("100000"), // 100,000s -> must never be honored verbatim
            text: async () => "",
          };
        }
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({
            choices: [
              { message: { content: JSON.stringify({ formattedCompanyName: "Packer" }) } },
            ],
          }),
        };
      }) as unknown as typeof fetch;

      const result = await cleanCompanyName("PACKER", "packer.com", {
        fetchImpl,
        apiKey: FAKE_API_KEY,
      });
      restore();

      expect(result).toBe("Packer");
      expect(delays.length).toBeGreaterThanOrEqual(1);
      expect(Math.max(...delays)).toBeLessThanOrEqual(RATE_LIMIT_MAX_DELAY_MS);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
    });
  });
});
