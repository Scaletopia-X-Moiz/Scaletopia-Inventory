import { describe, expect, it, vi } from "vitest";
import { verifyEmail, firstEmail, VERIFY_STATUSES } from "@/lib/millionverifier/verify";

function jsonFetch(body: unknown, ok = true, statusCode = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status: statusCode,
    json: async () => body,
  }) as unknown as typeof fetch;
}

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

describe("verifyEmail", () => {
  const apiKey = "test-key";

  it("returns a normalized result on success", async () => {
    const fetchImpl = jsonFetch({
      email: "someone@acme.com",
      result: "ok",
      quality: "good",
      credits: 42,
      error: "",
    });

    const result = await verifyEmail("someone@acme.com", { fetchImpl, apiKey });

    expect(result).toEqual({
      email: "someone@acme.com",
      status: "ok",
      quality: "good",
      credits: 42,
    });
    expect(VERIFY_STATUSES.has(result.status)).toBe(true);
  });

  it("sends the api key, email and a timeout in the query string", async () => {
    const fetchImpl = jsonFetch({ result: "invalid" });
    await verifyEmail("bad@acme.com", { fetchImpl, apiKey });

    const calledUrl = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const url = new URL(calledUrl);
    expect(url.searchParams.get("api")).toBe("test-key");
    expect(url.searchParams.get("email")).toBe("bad@acme.com");
    expect(url.searchParams.get("timeout")).toBeTruthy();
  });

  it("throws when the API reports an error (bad key / no credits)", async () => {
    const fetchImpl = jsonFetch({ error: "Insufficient credits" });
    await expect(verifyEmail("someone@acme.com", { fetchImpl, apiKey })).rejects.toThrow(
      /Insufficient credits/
    );
  });

  it("throws on an unexpected result value", async () => {
    const fetchImpl = jsonFetch({ result: "wat" });
    await expect(verifyEmail("someone@acme.com", { fetchImpl, apiKey })).rejects.toThrow(
      /unexpected result/
    );
  });

  it("throws on a non-200 HTTP response", async () => {
    const fetchImpl = jsonFetch({}, false, 503);
    await expect(verifyEmail("someone@acme.com", { fetchImpl, apiKey })).rejects.toThrow(
      /HTTP 503/
    );
  });

  it("throws when no api key is available", async () => {
    const fetchImpl = jsonFetch({ result: "ok" });
    await expect(verifyEmail("someone@acme.com", { fetchImpl, apiKey: "" })).rejects.toThrow(
      /MILLIONVERIFIER_API_KEY/
    );
  });

  it("throws when the email is blank", async () => {
    const fetchImpl = jsonFetch({ result: "ok" });
    await expect(verifyEmail("   ", { fetchImpl, apiKey })).rejects.toThrow(/No email/);
  });
});
