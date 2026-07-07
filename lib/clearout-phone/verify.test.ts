import { describe, expect, it, vi } from "vitest";
import { verifyPhone } from "@/lib/clearout-phone/verify";

function jsonFetch(body: unknown, ok = true, statusCode = 200): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok,
    status: statusCode,
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe("verifyPhone", () => {
  const apiKey = "test-token";

  it("returns a normalized result on success", async () => {
    const fetchImpl = jsonFetch({
      status: "success",
      data: {
        status: "valid",
        line_type: "mobile",
        carrier: "Verizon",
        location: "California",
      },
    });

    const result = await verifyPhone("+16502530000", { fetchImpl, apiKey });

    expect(result).toEqual({
      phone: "+16502530000",
      status: "valid",
      lineType: "mobile",
      carrier: "Verizon",
      location: "California",
    });
  });

  it("treats an empty line_type as null (invalid numbers)", async () => {
    const fetchImpl = jsonFetch({
      status: "success",
      data: { status: "invalid", line_type: "", carrier: "", location: "" },
    });

    const result = await verifyPhone("+10000000000", { fetchImpl, apiKey });

    expect(result.status).toBe("invalid");
    expect(result.lineType).toBeNull();
  });

  it("passes an unexpected status value straight through instead of throwing", async () => {
    const fetchImpl = jsonFetch({
      status: "success",
      data: { status: "wat", line_type: "", carrier: "", location: "" },
    });

    const result = await verifyPhone("+16502530000", { fetchImpl, apiKey });
    expect(result.status).toBe("wat");
  });

  it("sends the Authorization header in the literal Bearer:<token> form", async () => {
    const fetchImpl = jsonFetch({ status: "success", data: { status: "valid", line_type: "mobile" } });
    await verifyPhone("+16502530000", { fetchImpl, apiKey });

    const init = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer:test-token");
    expect(JSON.parse(init.body as string)).toEqual({ number: "+16502530000" });
  });

  it("throws when the API reports an error (e.g. bad token)", async () => {
    const fetchImpl = jsonFetch({ status: "failed", error: { code: 1000, message: "User not found" } });
    await expect(verifyPhone("+16502530000", { fetchImpl, apiKey })).rejects.toThrow(
      /User not found/
    );
  });

  it("throws on a non-200 HTTP response", async () => {
    const fetchImpl = jsonFetch({}, false, 503);
    await expect(verifyPhone("+16502530000", { fetchImpl, apiKey })).rejects.toThrow(/HTTP 503/);
  });

  it("throws when no api key is available", async () => {
    const fetchImpl = jsonFetch({ status: "success", data: { status: "valid" } });
    await expect(verifyPhone("+16502530000", { fetchImpl, apiKey: "" })).rejects.toThrow(
      /CLEAROUT_PHONE_API_TOKEN/
    );
  });

  it("throws when the phone is blank", async () => {
    const fetchImpl = jsonFetch({ status: "success", data: { status: "valid" } });
    await expect(verifyPhone("   ", { fetchImpl, apiKey })).rejects.toThrow(/No phone/);
  });
});
