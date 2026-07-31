import { describe, expect, it, vi } from "vitest";
import {
  upsertLeadsBulk,
  listCampaigns,
  attachLeadsToCampaign,
  listCustomVariables,
  createCustomVariable,
  requestWithRetry,
  EmailBisonApiError,
  EMAILBISON_RETRY_MAX_RETRIES,
  EMAILBISON_RETRY_MAX_DELAY_MS,
} from "@/lib/emailbison/client";
import type { EmailBisonCredentials, EmailBisonLeadPayload } from "@/lib/emailbison/types";

const CREDENTIALS: EmailBisonCredentials = {
  apiKey: "test-api-key",
  workspaceId: "https://dedi.emailbison.com",
};

const LEAD: EmailBisonLeadPayload = {
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  companyName: "Acme",
  title: "Engineer",
  phone: "+15551234567",
  website: "acme.com",
  existingLeadBehavior: "patch",
  customVariables: [{ name: "industry", value: "IoT" }],
};

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
        .mockResolvedValueOnce(jsonResponse(200, { data: [] }));

      const result = await requestWithRetry(fetchImpl, CREDENTIALS, "/api/leads/create-or-update/multiple", {
        leads: [],
      });

      expect(result).toEqual({ status: 200, json: { data: [] } });
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
        .mockResolvedValueOnce(jsonResponse(200, { data: [] }));

      const result = await requestWithRetry(fetchImpl, CREDENTIALS, "/api/leads/create-or-update/multiple", {});

      expect(result).toEqual({ status: 200, json: { data: [] } });
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
        .mockResolvedValueOnce(jsonResponse(200, { data: [] }));

      await requestWithRetry(fetchImpl, CREDENTIALS, "/api/leads/create-or-update/multiple", {});

      expect(delays[0]).toBe(EMAILBISON_RETRY_MAX_DELAY_MS);
    } finally {
      restore();
    }
  });

  it("gives up after exhausting the retry budget on persistent transient failures", async () => {
    const { restore } = captureRetryDelays();
    try {
      const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(500, { message: "down" }));

      await expect(
        requestWithRetry(fetchImpl, CREDENTIALS, "/api/leads/create-or-update/multiple", {})
      ).rejects.toThrow(EmailBisonApiError);

      expect(fetchImpl).toHaveBeenCalledTimes(EMAILBISON_RETRY_MAX_RETRIES + 1);
    } finally {
      restore();
    }
  });
});

describe("upsertLeadsBulk", () => {
  it("posts the leads envelope in snake_case and returns typed results", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: [{ id: 1, email: "ada@example.com" }] })
    );

    const result = await upsertLeadsBulk(CREDENTIALS, [LEAD], { fetchImpl });

    expect(result).toEqual([{ id: "1", email: "ada@example.com" }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${CREDENTIALS.workspaceId}/api/leads/create-or-update/multiple`);
    expect(JSON.parse(init.body)).toEqual({
      leads: [
        {
          email: "ada@example.com",
          first_name: "Ada",
          last_name: "Lovelace",
          company_name: "Acme",
          title: "Engineer",
          phone: "+15551234567",
          website: "acme.com",
          existing_lead_behavior: "patch",
          custom_variables: [{ name: "industry", value: "IoT" }],
        },
      ],
    });
    expect(init.headers.Authorization).toBe("Bearer test-api-key");
  });

  it("throws a typed EmailBisonApiError on a non-transient failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(401, { message: "invalid token" }));

    await expect(upsertLeadsBulk(CREDENTIALS, [LEAD], { fetchImpl })).rejects.toThrow(EmailBisonApiError);
  });
});

describe("listCampaigns", () => {
  it("gets the paginated campaign list", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, {
        data: [{ id: 10, name: "Q3 outbound" }],
        meta: { current_page: 1, last_page: 3 },
      })
    );

    const result = await listCampaigns(CREDENTIALS, 1, { fetchImpl });

    expect(result).toEqual({
      campaigns: [{ id: "10", name: "Q3 outbound" }],
      page: 1,
      hasMore: true,
    });
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${CREDENTIALS.workspaceId}/api/campaigns?page=1`);
  });

  it("reports no more pages once current_page reaches last_page", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: [], meta: { current_page: 3, last_page: 3 } })
    );

    const result = await listCampaigns(CREDENTIALS, 3, { fetchImpl });

    expect(result.hasMore).toBe(false);
  });
});

describe("attachLeadsToCampaign", () => {
  it("posts lead_ids to the attach-leads endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { message: "queued" }));

    await attachLeadsToCampaign(CREDENTIALS, "camp_1", ["1", "2"], { parallel: true }, { fetchImpl });

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${CREDENTIALS.workspaceId}/api/campaigns/camp_1/leads/attach-leads`);
    expect(JSON.parse(init.body)).toEqual({ lead_ids: ["1", "2"], parallel: true });
  });

  it("omits parallel from the body when not provided", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { message: "queued" }));

    await attachLeadsToCampaign(CREDENTIALS, "camp_1", ["1"], {}, { fetchImpl });

    const [, init] = fetchImpl.mock.calls[0];
    expect(JSON.parse(init.body)).toEqual({ lead_ids: ["1"] });
  });

  it("throws a typed error on failure", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(404, { message: "campaign not found" }));

    await expect(
      attachLeadsToCampaign(CREDENTIALS, "missing", ["1"], {}, { fetchImpl })
    ).rejects.toThrow(EmailBisonApiError);
  });
});

describe("listCustomVariables", () => {
  it("gets the workspace's custom variables", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, { data: [{ id: 5, name: "industry" }] }));

    const result = await listCustomVariables(CREDENTIALS, { fetchImpl });

    expect(result).toEqual([{ id: "5", name: "industry" }]);
    const [url] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${CREDENTIALS.workspaceId}/api/custom-variables`);
  });
});

describe("createCustomVariable", () => {
  it("posts the variable name and returns the created variable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { data: { id: 6, name: "seniority" } }));

    const result = await createCustomVariable(CREDENTIALS, "seniority", { fetchImpl });

    expect(result).toEqual({ id: "6", name: "seniority" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${CREDENTIALS.workspaceId}/api/custom-variables`);
    expect(JSON.parse(init.body)).toEqual({ name: "seniority" });
  });

  it("also accepts a flat (non-data-wrapped) created-variable response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(201, { id: 7, name: "flat" }));

    const result = await createCustomVariable(CREDENTIALS, "flat", { fetchImpl });

    expect(result).toEqual({ id: "7", name: "flat" });
  });

  it("throws a typed error when the response has no usable variable", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(200, {}));

    await expect(createCustomVariable(CREDENTIALS, "broken", { fetchImpl })).rejects.toThrow(EmailBisonApiError);
  });
});
