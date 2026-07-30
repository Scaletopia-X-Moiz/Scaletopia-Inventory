import { afterEach, describe, expect, it, vi } from "vitest";
import { GhlApiError } from "@/lib/ghl/client";
import { clearGhlCustomFieldsCache, getGhlCustomFields } from "@/lib/ghl/custom-fields";

const CLIENT_A = { id: "client-a", apiKey: "key-a", locationId: "loc-a" };
const CLIENT_B = { id: "client-b", apiKey: "key-b", locationId: "loc-b" };

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

afterEach(() => {
  clearGhlCustomFieldsCache();
});

describe("getGhlCustomFields", () => {
  it("fetches and maps a client's custom fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        customFields: [{ id: "f1", name: "Favorite Color", fieldKey: "contact.favorite_color", dataType: "TEXT" }],
      })
    );

    const fields = await getGhlCustomFields(CLIENT_A, { fetchImpl });

    expect(fields).toEqual([
      { id: "f1", name: "Favorite Color", fieldKey: "contact.favorite_color", dataType: "TEXT" },
    ]);
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://services.leadconnectorhq.com/locations/loc-a/customFields");
  });

  it("does not refetch on a second call for the same client within a session", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { customFields: [] }));

    await getGhlCustomFields(CLIENT_A, { fetchImpl });
    await getGhlCustomFields(CLIENT_A, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent calls for the same client into a single request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { customFields: [] }));

    await Promise.all([
      getGhlCustomFields(CLIENT_A, { fetchImpl }),
      getGhlCustomFields(CLIENT_A, { fetchImpl }),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caches independently per client", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { customFields: [] }));

    await getGhlCustomFields(CLIENT_A, { fetchImpl });
    await getGhlCustomFields(CLIENT_B, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws GhlApiError on a failed fetch and does not cache the failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: "invalid api key" }))
      .mockResolvedValueOnce(jsonResponse(200, { customFields: [] }));

    await expect(getGhlCustomFields(CLIENT_A, { fetchImpl })).rejects.toThrow(GhlApiError);

    const fields = await getGhlCustomFields(CLIENT_A, { fetchImpl });
    expect(fields).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
