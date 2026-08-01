import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailBisonApiError } from "@/lib/emailbison/client";
import { clearEmailBisonCampaignsCache, getEmailBisonCampaigns } from "@/lib/emailbison/campaigns";

const CLIENT_A = { id: "client-a", apiKey: "key-a", workspaceId: "https://a.emailbison.com" };
const CLIENT_B = { id: "client-b", apiKey: "key-b", workspaceId: "https://b.emailbison.com" };

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

afterEach(() => {
  clearEmailBisonCampaignsCache();
});

describe("getEmailBisonCampaigns", () => {
  it("fetches and maps a client's campaign list", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [{ id: 1, name: "Q3 Outbound" }],
        meta: { current_page: 1, last_page: 1 },
      })
    );

    const campaigns = await getEmailBisonCampaigns(CLIENT_A, { fetchImpl });

    expect(campaigns).toEqual([{ id: "1", name: "Q3 Outbound" }]);
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${CLIENT_A.workspaceId}/api/campaigns?page=1`);
  });

  it("walks every page until the list is exhausted", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { data: [{ id: 1, name: "Page 1 campaign" }], meta: { current_page: 1, last_page: 2 } })
      )
      .mockResolvedValueOnce(
        jsonResponse(200, { data: [{ id: 2, name: "Page 2 campaign" }], meta: { current_page: 2, last_page: 2 } })
      );

    const campaigns = await getEmailBisonCampaigns(CLIENT_A, { fetchImpl });

    expect(campaigns).toEqual([
      { id: "1", name: "Page 1 campaign" },
      { id: "2", name: "Page 2 campaign" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[1][0]).toBe(`${CLIENT_A.workspaceId}/api/campaigns?page=2`);
  });

  it("does not refetch on a second call for the same client within a session", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: [], meta: { current_page: 1, last_page: 1 } }));

    await getEmailBisonCampaigns(CLIENT_A, { fetchImpl });
    await getEmailBisonCampaigns(CLIENT_A, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent calls for the same client into a single fetch sequence", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: [], meta: { current_page: 1, last_page: 1 } }));

    await Promise.all([
      getEmailBisonCampaigns(CLIENT_A, { fetchImpl }),
      getEmailBisonCampaigns(CLIENT_A, { fetchImpl }),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caches independently per client, refetching on a workspace change", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: [], meta: { current_page: 1, last_page: 1 } }));

    await getEmailBisonCampaigns(CLIENT_A, { fetchImpl });
    await getEmailBisonCampaigns(CLIENT_B, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws EmailBisonApiError and does not cache the failure when a later page rejects", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { data: [{ id: 1, name: "Page 1 campaign" }], meta: { current_page: 1, last_page: 2 } })
      )
      .mockResolvedValueOnce(jsonResponse(401, { message: "invalid api key" }))
      .mockResolvedValueOnce(
        jsonResponse(200, { data: [{ id: 1, name: "Page 1 campaign" }], meta: { current_page: 1, last_page: 1 } })
      );

    await expect(getEmailBisonCampaigns(CLIENT_A, { fetchImpl })).rejects.toThrow(EmailBisonApiError);

    const campaigns = await getEmailBisonCampaigns(CLIENT_A, { fetchImpl });
    expect(campaigns).toEqual([{ id: "1", name: "Page 1 campaign" }]);
  });

  it("throws instead of looping forever when hasMore never resolves to false", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: string) => {
      const page = Number(new URL(url).searchParams.get("page"));
      return jsonResponse(200, {
        data: [{ id: page, name: `Campaign ${page}` }],
        meta: { current_page: page, last_page: page + 1 },
      });
    });

    await expect(getEmailBisonCampaigns(CLIENT_A, { fetchImpl })).rejects.toThrow(EmailBisonApiError);
  });

  it("throws EmailBisonApiError on a failed fetch and does not cache the failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: "invalid api key" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [], meta: { current_page: 1, last_page: 1 } }));

    await expect(getEmailBisonCampaigns(CLIENT_A, { fetchImpl })).rejects.toThrow(EmailBisonApiError);

    const campaigns = await getEmailBisonCampaigns(CLIENT_A, { fetchImpl });
    expect(campaigns).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
