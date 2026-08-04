import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailBisonApiError } from "@/lib/emailbison/client";
import {
  appendEmailBisonCustomVariablesCache,
  clearEmailBisonCustomVariablesCache,
  getEmailBisonCustomVariables,
} from "@/lib/emailbison/custom-variables";

const WORKSPACE_A = { apiKey: "key-a", workspaceId: "https://a.emailbison.com" };
const WORKSPACE_B = { apiKey: "key-b", workspaceId: "https://b.emailbison.com" };

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    headers: { get: () => null },
  } as unknown as Response;
}

afterEach(() => {
  clearEmailBisonCustomVariablesCache();
});

describe("getEmailBisonCustomVariables", () => {
  it("fetches and maps a workspace's custom variables", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: [{ id: "v1", name: "favorite_color" }] })
    );

    const variables = await getEmailBisonCustomVariables(WORKSPACE_A, { fetchImpl });

    expect(variables).toEqual([{ id: "v1", name: "favorite_color" }]);
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://a.emailbison.com/api/custom-variables");
  });

  it("does not refetch on a second call for the same workspace within a session", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }));

    await getEmailBisonCustomVariables(WORKSPACE_A, { fetchImpl });
    await getEmailBisonCustomVariables(WORKSPACE_A, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("collapses concurrent calls for the same workspace into a single request", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }));

    await Promise.all([
      getEmailBisonCustomVariables(WORKSPACE_A, { fetchImpl }),
      getEmailBisonCustomVariables(WORKSPACE_A, { fetchImpl }),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("caches independently per workspace, refetching on workspace change", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }));

    await getEmailBisonCustomVariables(WORKSPACE_A, { fetchImpl });
    await getEmailBisonCustomVariables(WORKSPACE_B, { fetchImpl });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("throws EmailBisonApiError on a failed fetch and does not cache the failure", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(401, { message: "invalid api key" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: [] }));

    await expect(getEmailBisonCustomVariables(WORKSPACE_A, { fetchImpl })).rejects.toThrow(EmailBisonApiError);

    const variables = await getEmailBisonCustomVariables(WORKSPACE_A, { fetchImpl });
    expect(variables).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("appendEmailBisonCustomVariablesCache", () => {
  it("seeds the cache when nothing has been fetched yet for the workspace", async () => {
    const fetchImpl = vi.fn();

    await appendEmailBisonCustomVariablesCache(WORKSPACE_A.workspaceId, [{ id: "v1", name: "new_var" }]);
    const variables = await getEmailBisonCustomVariables(WORKSPACE_A, { fetchImpl });

    expect(variables).toEqual([{ id: "v1", name: "new_var" }]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("appends to an already-resolved cache entry without refetching", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ id: "v1", name: "existing" }] }));

    const first = await getEmailBisonCustomVariables(WORKSPACE_A, { fetchImpl });
    expect(first).toEqual([{ id: "v1", name: "existing" }]);

    await appendEmailBisonCustomVariablesCache(WORKSPACE_A.workspaceId, [{ id: "v2", name: "brand_new" }]);
    const second = await getEmailBisonCustomVariables(WORKSPACE_A, { fetchImpl });

    expect(second).toEqual([
      { id: "v1", name: "existing" },
      { id: "v2", name: "brand_new" },
    ]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("is a no-op when given an empty list", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [] }));

    await appendEmailBisonCustomVariablesCache(WORKSPACE_A.workspaceId, []);
    const variables = await getEmailBisonCustomVariables(WORKSPACE_A, { fetchImpl });

    expect(variables).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("re-seeds the cache after a prior failed fetch self-evicted it", async () => {
    // 401 (not 5xx) so requestGetWithRetry's retry loop doesn't retry it —
    // same non-retryable-status choice as the "does not cache the failure"
    // case above.
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { message: "invalid api key" }));
    await expect(getEmailBisonCustomVariables(WORKSPACE_A, { fetchImpl })).rejects.toThrow(EmailBisonApiError);

    await appendEmailBisonCustomVariablesCache(WORKSPACE_A.workspaceId, [{ id: "v1", name: "new_var" }]);
    const variables = await getEmailBisonCustomVariables(WORKSPACE_A, { fetchImpl });

    expect(variables).toEqual([{ id: "v1", name: "new_var" }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
