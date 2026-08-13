import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailBisonApiError } from "@/lib/emailbison/client";
import {
  clearEmailBisonCampaignsCache,
  getEmailBisonCampaigns,
  createEmailBisonCampaign,
  type CreateEmailBisonCampaignInput,
} from "@/lib/emailbison/campaigns";

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

const NEW_CAMPAIGN_ID = "100";

function buildCreateInput(overrides: Partial<CreateEmailBisonCampaignInput> = {}): CreateEmailBisonCampaignInput {
  return {
    name: "New Campaign",
    senderEmailIds: ["1", "2"],
    schedule: {
      monday: true,
      tuesday: true,
      wednesday: true,
      thursday: true,
      friday: true,
      saturday: false,
      sunday: false,
      startTime: "09:00",
      endTime: "17:00",
      timezone: "UTC",
    },
    steps: [{ emailSubject: "Hi", emailBody: "Body", waitInDays: 0, threadReply: false }],
    launch: false,
    ...overrides,
  };
}

/** A fetchImpl resolving every step of createEmailBisonCampaign's chain
 * successfully, logging each call as "METHOD url" to `callLog`. */
function fullSuccessFetch(callLog: string[]): typeof fetch {
  return vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    callLog.push(`${method} ${u}`);
    if (u.endsWith("/api/campaigns") && method === "POST") {
      return jsonResponse(201, { data: { id: 100, name: "New Campaign", status: "draft" } });
    }
    if (u.endsWith(`/api/campaigns/${NEW_CAMPAIGN_ID}/attach-sender-emails`)) {
      return jsonResponse(200, { data: { success: true, message: "ok" } });
    }
    if (u.endsWith(`/api/campaigns/${NEW_CAMPAIGN_ID}/schedule`)) {
      return jsonResponse(201, { data: { id: 5 } });
    }
    if (u.endsWith(`/api/campaigns/${NEW_CAMPAIGN_ID}/sequence-steps`)) {
      return jsonResponse(201, { data: { id: 9, sequence_steps: [{ id: 1 }] } });
    }
    if (u.endsWith(`/api/campaigns/${NEW_CAMPAIGN_ID}/resume`)) {
      return jsonResponse(200, { data: { success: true, message: "ok" } });
    }
    throw new Error(`unexpected fetch to ${method} ${u}`);
  }) as unknown as typeof fetch;
}

/** Ordered list of the chain's steps after createCampaign, mirroring
 * createEmailBisonCampaign's documented sequence. Used by fetchFailingAt to
 * let every step before the failure point succeed normally. */
const CHAIN_STEP_SUFFIXES = ["/attach-sender-emails", "/schedule", "/sequence-steps", "/resume"];

/** A fetchImpl that resolves createCampaign and every chain step before
 * `failAtSuffix` normally, fails `failAtSuffix` itself with a non-transient
 * 401 (so client.ts's retry/backoff never kicks in and the test stays fast),
 * and throws if any step after it is ever reached — proving the chain
 * stopped at the failure point. */
function fetchFailingAt(failAtSuffix: string): typeof fetch {
  const failIndex = CHAIN_STEP_SUFFIXES.indexOf(failAtSuffix);
  if (failIndex === -1) throw new Error(`unknown chain step suffix: ${failAtSuffix}`);

  return vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";
    if (u.endsWith("/api/campaigns") && method === "POST") {
      return jsonResponse(201, { data: { id: 100, name: "New Campaign", status: "draft" } });
    }
    if (u.endsWith(failAtSuffix)) {
      return jsonResponse(401, { message: "boom" });
    }
    const stepIndex = CHAIN_STEP_SUFFIXES.findIndex((suffix) => u.endsWith(suffix));
    if (stepIndex !== -1 && stepIndex < failIndex) {
      // A step before the failure point — resolve it as the happy-path fetch would.
      if (stepIndex === 0) return jsonResponse(200, { data: { success: true, message: "ok" } });
      if (stepIndex === 1) return jsonResponse(201, { data: { id: 5 } });
      if (stepIndex === 2) return jsonResponse(201, { data: { id: 9, sequence_steps: [{ id: 1 }] } });
      return jsonResponse(200, { data: { success: true, message: "ok" } });
    }
    if (stepIndex !== -1 && stepIndex > failIndex) {
      throw new Error(`chain should have stopped before reaching ${method} ${u}`);
    }
    throw new Error(`unexpected fetch to ${method} ${u}`);
  }) as unknown as typeof fetch;
}

describe("createEmailBisonCampaign", () => {
  it("runs create -> attach -> schedule -> sequence-steps, skipping resume when launch is false", async () => {
    const callLog: string[] = [];
    const fetchImpl = fullSuccessFetch(callLog);

    const campaign = await createEmailBisonCampaign(CLIENT_A, buildCreateInput({ launch: false }), { fetchImpl });

    expect(campaign).toEqual({ id: "100", name: "New Campaign" });
    expect(callLog).toEqual([
      `POST ${CLIENT_A.workspaceId}/api/campaigns`,
      `POST ${CLIENT_A.workspaceId}/api/campaigns/100/attach-sender-emails`,
      `POST ${CLIENT_A.workspaceId}/api/campaigns/100/schedule`,
      `POST ${CLIENT_A.workspaceId}/api/campaigns/100/sequence-steps`,
    ]);
  });

  it("also calls resumeCampaign, as the final step, when launch is true", async () => {
    const callLog: string[] = [];
    const fetchImpl = fullSuccessFetch(callLog);

    const campaign = await createEmailBisonCampaign(CLIENT_A, buildCreateInput({ launch: true }), { fetchImpl });

    expect(campaign).toEqual({ id: "100", name: "New Campaign" });
    expect(callLog).toEqual([
      `POST ${CLIENT_A.workspaceId}/api/campaigns`,
      `POST ${CLIENT_A.workspaceId}/api/campaigns/100/attach-sender-emails`,
      `POST ${CLIENT_A.workspaceId}/api/campaigns/100/schedule`,
      `POST ${CLIENT_A.workspaceId}/api/campaigns/100/sequence-steps`,
      `PATCH ${CLIENT_A.workspaceId}/api/campaigns/100/resume`,
    ]);
  });

  it("stops the chain and names attaching senders when attach-sender-emails fails", async () => {
    const fetchImpl = fetchFailingAt("/attach-sender-emails");

    await expect(createEmailBisonCampaign(CLIENT_A, buildCreateInput({ launch: true }), { fetchImpl })).rejects.toThrow(
      "Campaign created but attaching senders failed"
    );
  });

  it("stops the chain and names the schedule step when createCampaignSchedule fails", async () => {
    const fetchImpl = fetchFailingAt("/schedule");

    await expect(createEmailBisonCampaign(CLIENT_A, buildCreateInput({ launch: true }), { fetchImpl })).rejects.toThrow(
      "Campaign created but creating the schedule failed"
    );
  });

  it("stops the chain and names the sequence-steps step when createSequenceSteps fails", async () => {
    const fetchImpl = fetchFailingAt("/sequence-steps");

    await expect(createEmailBisonCampaign(CLIENT_A, buildCreateInput({ launch: true }), { fetchImpl })).rejects.toThrow(
      "Campaign created but creating sequence steps failed"
    );
  });

  it("stops the chain and names the resume step when resumeCampaign fails (launch: true only)", async () => {
    const fetchImpl = fetchFailingAt("/resume");

    await expect(createEmailBisonCampaign(CLIENT_A, buildCreateInput({ launch: true }), { fetchImpl })).rejects.toThrow(
      "Campaign created but launching (resume) the campaign failed"
    );
  });

  it("does not call resumeCampaign, and does not fail, when launch is false even though resume would fail", async () => {
    // Using fetchFailingAt("/resume") but launch: false proves resume is never reached/called.
    const fetchImpl = fetchFailingAt("/resume");

    const campaign = await createEmailBisonCampaign(CLIENT_A, buildCreateInput({ launch: false }), { fetchImpl });

    expect(campaign).toEqual({ id: "100", name: "New Campaign" });
  });

  it("appends the created campaign to an existing cached list in place, without a new getEmailBisonCampaigns fetch", async () => {
    const listFetch = vi.fn().mockResolvedValue(
      jsonResponse(200, { data: [{ id: 1, name: "Existing" }], meta: { current_page: 1, last_page: 1 } })
    );
    const existing = await getEmailBisonCampaigns(CLIENT_A, { fetchImpl: listFetch });
    expect(existing).toEqual([{ id: "1", name: "Existing" }]);

    const callLog: string[] = [];
    await createEmailBisonCampaign(CLIENT_A, buildCreateInput({ launch: false }), { fetchImpl: fullSuccessFetch(callLog) });

    const afterCreateFetch = vi.fn();
    const after = await getEmailBisonCampaigns(CLIENT_A, { fetchImpl: afterCreateFetch });

    expect(after).toEqual([
      { id: "1", name: "Existing" },
      { id: "100", name: "New Campaign" },
    ]);
    expect(afterCreateFetch).not.toHaveBeenCalled();
  });

  it("seeds the cache with the new campaign when nothing was cached yet for this client", async () => {
    const callLog: string[] = [];
    await createEmailBisonCampaign(CLIENT_B, buildCreateInput({ launch: false }), { fetchImpl: fullSuccessFetch(callLog) });

    const afterCreateFetch = vi.fn();
    const after = await getEmailBisonCampaigns(CLIENT_B, { fetchImpl: afterCreateFetch });

    expect(after).toEqual([{ id: "100", name: "New Campaign" }]);
    expect(afterCreateFetch).not.toHaveBeenCalled();
  });
});

describe("createEmailBisonCampaign — split test variants", () => {
  /** A fetchImpl covering the whole chain plus two extra variants on a single
   * base step, mirroring EmailBison's live-verified flow (issue #143): the
   * base `sequence-steps` POST creates the sequence (id 9) and its base step
   * (id 201); each later `sequence-steps` POST APPENDS to that one sequence and
   * returns ALL steps so far, newest LAST (so variant B is [201, 202], variant
   * C is [201, 202, 203]). The v1.1 GET then returns the whole sequence with
   * EmailBison-assigned orders, and a single v1.1 PUT links every variant. */
  function variantsFetch(callLog: string[]): typeof fetch {
    let sequenceStepsCallCount = 0;
    const appended = [201, 202, 203]; // base, variant B, variant C — in creation order
    const getSteps = [
      { id: 201, email_subject: "Base subject", order: 1, email_body: "Base body", wait_in_days: 0, thread_reply: false },
      { id: 202, email_subject: "Variant B subject", order: 2, email_body: "Variant B body", wait_in_days: 0, thread_reply: false },
      { id: 203, email_subject: "Variant C subject", order: 3, email_body: "Variant C body", wait_in_days: 0, thread_reply: false },
    ];

    return vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      callLog.push(`${method} ${u}${init?.body ? ` ${init.body}` : ""}`);

      if (u.endsWith("/api/campaigns") && method === "POST") {
        return jsonResponse(201, { data: { id: 100, name: "New Campaign", status: "draft" } });
      }
      if (u.endsWith(`/api/campaigns/${NEW_CAMPAIGN_ID}/attach-sender-emails`)) {
        return jsonResponse(200, { data: { success: true, message: "ok" } });
      }
      if (u.endsWith(`/api/campaigns/${NEW_CAMPAIGN_ID}/schedule`)) {
        return jsonResponse(201, { data: { id: 5 } });
      }
      if (u.endsWith(`/api/campaigns/${NEW_CAMPAIGN_ID}/sequence-steps`) && method === "POST") {
        // Each POST appends; return the sequence's steps so far, newest last.
        const steps = appended.slice(0, sequenceStepsCallCount + 1).map((id) => ({ id }));
        sequenceStepsCallCount++;
        return jsonResponse(sequenceStepsCallCount === 1 ? 201 : 200, { data: { id: 9, sequence_steps: steps } });
      }
      if (u.endsWith(`/api/campaigns/v1.1/${NEW_CAMPAIGN_ID}/sequence-steps`) && method === "GET") {
        return jsonResponse(200, { data: { sequence_id: 9, sequence_steps: getSteps } });
      }
      if (u.endsWith(`/api/campaigns/v1.1/sequence-steps/9`) && method === "PUT") {
        return jsonResponse(200, { data: { success: true, message: "ok" } });
      }
      throw new Error(`unexpected fetch to ${method} ${u}`);
    }) as unknown as typeof fetch;
  }

  function buildVariantInput(): CreateEmailBisonCampaignInput {
    return buildCreateInput({
      steps: [
        {
          emailSubject: "Base subject",
          emailBody: "Base body",
          waitInDays: 0,
          threadReply: false,
          extraVariants: [
            { emailSubject: "Variant B subject", emailBody: "Variant B body" },
            { emailSubject: "Variant C subject", emailBody: "Variant C body" },
          ],
        },
      ],
    });
  }

  it("creates each extra variant as an appended step, then links them all in one v1.1 whole-sequence PUT", async () => {
    const callLog: string[] = [];
    const fetchImpl = variantsFetch(callLog);

    const campaign = await createEmailBisonCampaign(CLIENT_A, buildVariantInput(), { fetchImpl });

    expect(campaign).toEqual({ id: "100", name: "New Campaign" });
    expect(callLog).toEqual([
      `POST ${CLIENT_A.workspaceId}/api/campaigns ${JSON.stringify({ name: "New Campaign" })}`,
      `POST ${CLIENT_A.workspaceId}/api/campaigns/100/attach-sender-emails ${JSON.stringify({ sender_email_ids: ["1", "2"] })}`,
      `POST ${CLIENT_A.workspaceId}/api/campaigns/100/schedule ${JSON.stringify({
        monday: true,
        tuesday: true,
        wednesday: true,
        thursday: true,
        friday: true,
        saturday: false,
        sunday: false,
        start_time: "09:00",
        end_time: "17:00",
        timezone: "UTC",
        save_as_template: false,
      })}`,
      `POST ${CLIENT_A.workspaceId}/api/campaigns/100/sequence-steps ${JSON.stringify({
        title: "New Campaign",
        sequence_steps: [{ email_subject: "Base subject", email_body: "Base body", wait_in_days: 0, thread_reply: false }],
      })}`,
      `POST ${CLIENT_A.workspaceId}/api/campaigns/100/sequence-steps ${JSON.stringify({
        title: "New Campaign",
        sequence_steps: [
          { email_subject: "Variant B subject", email_body: "Variant B body", wait_in_days: 0, thread_reply: false },
        ],
      })}`,
      `POST ${CLIENT_A.workspaceId}/api/campaigns/100/sequence-steps ${JSON.stringify({
        title: "New Campaign",
        sequence_steps: [
          { email_subject: "Variant C subject", email_body: "Variant C body", wait_in_days: 0, thread_reply: false },
        ],
      })}`,
      `GET ${CLIENT_A.workspaceId}/api/campaigns/v1.1/100/sequence-steps`,
      `PUT ${CLIENT_A.workspaceId}/api/campaigns/v1.1/sequence-steps/9 ${JSON.stringify({
        title: "New Campaign",
        sequence_steps: [
          { id: 201, email_subject: "Base subject", order: 1, email_body: "Base body", wait_in_days: 0, thread_reply: false, variant: false },
          {
            id: 202,
            email_subject: "Variant B subject",
            order: 2,
            email_body: "Variant B body",
            wait_in_days: 0,
            thread_reply: false,
            variant: true,
            variant_from_step_id: 201,
          },
          {
            id: 203,
            email_subject: "Variant C subject",
            order: 3,
            email_body: "Variant C body",
            wait_in_days: 0,
            thread_reply: false,
            variant: true,
            variant_from_step_id: 201,
          },
        ],
      })}`,
    ]);
  });

  it("stops the chain and names the variant when creating an extra variant's sequence-step fails", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/campaigns") && method === "POST") {
        return jsonResponse(201, { data: { id: 100, name: "New Campaign", status: "draft" } });
      }
      if (u.endsWith(`/api/campaigns/${NEW_CAMPAIGN_ID}/attach-sender-emails`)) {
        return jsonResponse(200, { data: { success: true, message: "ok" } });
      }
      if (u.endsWith(`/api/campaigns/${NEW_CAMPAIGN_ID}/schedule`)) {
        return jsonResponse(201, { data: { id: 5 } });
      }
      if (u.endsWith(`/api/campaigns/${NEW_CAMPAIGN_ID}/sequence-steps`) && method === "POST") {
        const body = JSON.parse(String(init?.body));
        if (body.sequence_steps[0].email_subject === "Base subject") {
          return jsonResponse(201, { data: { id: 9, sequence_steps: [{ id: 201 }] } });
        }
        return jsonResponse(401, { message: "boom" });
      }
      throw new Error(`unexpected fetch to ${method} ${u}`);
    }) as unknown as typeof fetch;

    await expect(createEmailBisonCampaign(CLIENT_A, buildVariantInput(), { fetchImpl })).rejects.toThrow(
      "Campaign created but creating split test variant B for step 1 failed"
    );
  });

  it("stops the chain and names the linking step when the whole-sequence variant PUT fails", async () => {
    const fetchImpl = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.endsWith("/api/campaigns") && method === "POST") {
        return jsonResponse(201, { data: { id: 100, name: "New Campaign", status: "draft" } });
      }
      if (u.endsWith(`/api/campaigns/${NEW_CAMPAIGN_ID}/attach-sender-emails`)) {
        return jsonResponse(200, { data: { success: true, message: "ok" } });
      }
      if (u.endsWith(`/api/campaigns/${NEW_CAMPAIGN_ID}/schedule`)) {
        return jsonResponse(201, { data: { id: 5 } });
      }
      if (u.endsWith(`/api/campaigns/${NEW_CAMPAIGN_ID}/sequence-steps`) && method === "POST") {
        const body = JSON.parse(String(init?.body));
        const id = body.sequence_steps[0].email_subject === "Base subject" ? 201 : 202;
        return jsonResponse(201, { data: { id: 9, sequence_steps: [{ id }] } });
      }
      if (u.endsWith(`/api/campaigns/v1.1/${NEW_CAMPAIGN_ID}/sequence-steps`) && method === "GET") {
        return jsonResponse(200, {
          data: {
            sequence_id: 9,
            sequence_steps: [
              { id: 201, email_subject: "Base subject", order: 1, email_body: "Base body", wait_in_days: 0, thread_reply: false },
              { id: 202, email_subject: "Variant B subject", order: 2, email_body: "Variant B body", wait_in_days: 0, thread_reply: false },
            ],
          },
        });
      }
      if (u.includes("/api/campaigns/v1.1/sequence-steps/") && method === "PUT") {
        return jsonResponse(401, { message: "boom" });
      }
      throw new Error(`unexpected fetch to ${method} ${u}`);
    }) as unknown as typeof fetch;

    await expect(createEmailBisonCampaign(CLIENT_A, buildVariantInput(), { fetchImpl })).rejects.toThrow(
      "Campaign created but linking split test variants failed"
    );
  });

  it("does not read or PUT the v1.1 sequence at all when no step has extra variants", async () => {
    const callLog: string[] = [];
    const fetchImpl = fullSuccessFetch(callLog);

    await createEmailBisonCampaign(CLIENT_A, buildCreateInput({ launch: false }), { fetchImpl });

    expect(callLog.some((call) => call.startsWith("PUT"))).toBe(false);
    expect(callLog.some((call) => call.includes("/v1.1/"))).toBe(false);
  });
});
