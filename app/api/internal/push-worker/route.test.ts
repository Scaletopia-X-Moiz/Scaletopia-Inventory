import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PushJob } from "@/lib/data/push-jobs";
import type { ClientRow } from "@/lib/data/clients";

const { after } = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", () => ({ after }));

const { claimNextRunnableJob, resetStaleRunningJobs, getPushJob, updateJobProgress, finishJob, recordJobPeople } =
  vi.hoisted(() => ({
    claimNextRunnableJob: vi.fn(),
    resetStaleRunningJobs: vi.fn(),
    getPushJob: vi.fn(),
    updateJobProgress: vi.fn(),
    finishJob: vi.fn(),
    recordJobPeople: vi.fn(),
  }));
vi.mock("@/lib/data/push-jobs", () => ({
  claimNextRunnableJob,
  resetStaleRunningJobs,
  getPushJob,
  updateJobProgress,
  finishJob,
  recordJobPeople,
}));

const { getClientById } = vi.hoisted(() => ({ getClientById: vi.fn() }));
vi.mock("@/lib/data/clients", () => ({ getClientById }));

const { logActivity } = vi.hoisted(() => ({ logActivity: vi.fn() }));
vi.mock("@/lib/activity/log", () => ({ logActivity }));

const { runPeopleGhlPush } = vi.hoisted(() => ({ runPeopleGhlPush: vi.fn() }));
vi.mock("@/lib/ghl/push-to-ghl", () => ({ runPeopleGhlPush }));

const {
  runPeopleAddToEmailBison,
  runCompaniesAddToEmailBison,
  runPeopleAddToCampaign,
  runCompaniesAddToCampaign,
} = vi.hoisted(() => ({
  runPeopleAddToEmailBison: vi.fn(),
  runCompaniesAddToEmailBison: vi.fn(),
  runPeopleAddToCampaign: vi.fn(),
  runCompaniesAddToCampaign: vi.fn(),
}));
vi.mock("@/lib/emailbison/push-to-emailbison", () => ({
  runPeopleAddToEmailBison,
  runCompaniesAddToEmailBison,
  runPeopleAddToCampaign,
  runCompaniesAddToCampaign,
}));

const { resumeCampaign } = vi.hoisted(() => ({ resumeCampaign: vi.fn() }));
vi.mock("@/lib/emailbison/client", () => ({ resumeCampaign }));

const { GET, POST } = await import("@/app/api/internal/push-worker/route");

const testClient: ClientRow = {
  id: "client-1",
  slug: "acme",
  name: "Acme",
  ghlApiKey: "k",
  ghlLocationId: "loc",
  emailbisonApiKey: "key",
  emailbisonWorkspaceId: "ws",
  isActive: true,
  updatedAt: new Date().toISOString(),
};

function makeJob(overrides: Partial<PushJob> = {}): PushJob {
  return {
    id: "job-1",
    clientId: "client-1",
    platform: "ghl",
    entity: "people",
    action: null,
    campaignId: null,
    niche: [],
    filters: { niche: { include: ["widgets"], exclude: [] } },
    options: {},
    status: "running",
    total: 0,
    processed: 0,
    succeeded: 0,
    created: 0,
    updated: 0,
    failed: 0,
    failures: [],
    cursor: null,
    error: null,
    triggeredByUserId: "user-1",
    triggeredByEmail: "op@example.com",
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    finishedAt: null,
    ...overrides,
  };
}

function ghlResult(overrides: Record<string, unknown> = {}) {
  return {
    total_matched: 2,
    eligible: 2,
    skipped: 0,
    pushed: 2,
    created: 2,
    updated: 0,
    errors: 0,
    failed_people: [],
    succeededPersonIds: ["p1", "p2"],
    failedPersonIds: [],
    nextOffset: 2,
    done: true,
    ...overrides,
  };
}

const req = () => new Request("http://localhost/api/internal/push-worker", { method: "POST" });

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.CRON_SECRET;
  delete process.env.PUSH_WORKER_SECRET;
  getClientById.mockResolvedValue(testClient);
  resetStaleRunningJobs.mockResolvedValue(0);
  resumeCampaign.mockResolvedValue(undefined);
});

describe("push-worker auth", () => {
  it("skips the check when no secret env var is set", async () => {
    claimNextRunnableJob.mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(200);
  });

  it("401s when CRON_SECRET is set but the header is wrong", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await GET(new Request("http://localhost/api/internal/push-worker"));
    expect(res.status).toBe(401);
    expect(claimNextRunnableJob).not.toHaveBeenCalled();
  });

  it("accepts a matching x-worker-secret header", async () => {
    process.env.PUSH_WORKER_SECRET = "wsecret";
    claimNextRunnableJob.mockResolvedValue(null);
    const res = await POST(
      new Request("http://localhost/api/internal/push-worker", {
        method: "POST",
        headers: { "x-worker-secret": "wsecret" },
      })
    );
    expect(res.status).toBe(200);
  });
});

describe("push-worker stale-job reaper (#137)", () => {
  it("reaps stale running jobs before claiming, on every invocation", async () => {
    resetStaleRunningJobs.mockResolvedValue(2);
    claimNextRunnableJob.mockResolvedValue(null);

    const res = await POST(req());
    expect(res.status).toBe(200);

    // Runs once per invocation, ahead of the claim path, so a stranded row is
    // reclaimed before the loop looks for runnable work.
    expect(resetStaleRunningJobs).toHaveBeenCalledTimes(1);
    const reaperOrder = resetStaleRunningJobs.mock.invocationCallOrder[0];
    const claimOrder = claimNextRunnableJob.mock.invocationCallOrder[0];
    expect(reaperOrder).toBeLessThan(claimOrder);
  });

  it("runs the reaper on the cron GET backstop too", async () => {
    claimNextRunnableJob.mockResolvedValue(null);

    const res = await GET(new Request("http://localhost/api/internal/push-worker"));
    expect(res.status).toBe(200);
    expect(resetStaleRunningJobs).toHaveBeenCalledTimes(1);
  });

  it("continues the invocation when the reaper throws (e.g. SQL not yet applied)", async () => {
    resetStaleRunningJobs.mockRejectedValue(new Error("function reset_stale_running_jobs does not exist"));
    claimNextRunnableJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runPeopleGhlPush.mockResolvedValue(ghlResult());

    const res = await POST(req());
    expect(res.status).toBe(200);
    // The tick loop still ran and finished the claimed job despite the reaper error.
    expect(finishJob).toHaveBeenCalledWith("job-1", expect.objectContaining({ status: "succeeded" }));
  });
});

describe("push-worker dispatch + finish", () => {
  it("dispatches a GHL job, records people, finishes succeeded, logs activity, no self-chain", async () => {
    claimNextRunnableJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runPeopleGhlPush.mockResolvedValue(ghlResult());

    const res = await POST(req());
    expect(res.status).toBe(200);

    // Claim path (no jobId body) throttled by the concurrency cap.
    expect(claimNextRunnableJob).toHaveBeenCalledWith(expect.any(Number));

    expect(runPeopleGhlPush).toHaveBeenCalledTimes(1);
    const [filters, client, actor, deps] = runPeopleGhlPush.mock.calls[0];
    expect(client).toBe(testClient);
    expect(actor).toEqual({ id: "user-1", email: "op@example.com" });
    expect(deps.offset).toBe(0);
    expect(typeof deps.deadline).toBe("number");
    expect(filters).toMatchObject({ niche: { include: ["widgets"] } });

    expect(recordJobPeople).toHaveBeenCalledWith("job-1", [
      { personId: "p1", outcome: "succeeded" },
      { personId: "p2", outcome: "succeeded" },
    ]);
    expect(finishJob).toHaveBeenCalledWith("job-1", {
      status: "succeeded",
      // total/processed persisted on completion so the panel shows the real
      // count instead of "Total selected: 0" (feedback item 2a).
      total: 2,
      processed: 2,
      succeeded: 2,
      created: 2,
      updated: 0,
      failed: 0,
      failures: [],
      error: null,
    });
    expect(logActivity).toHaveBeenCalledWith(
      "ghl.push",
      expect.objectContaining({ jobId: "job-1", succeeded: 2, failed: 0, total: 2 }),
      { id: "user-1", email: "op@example.com" }
    );
    expect(after).not.toHaveBeenCalled();
    expect(updateJobProgress).not.toHaveBeenCalled();
  });

  it("finishes partial when some succeed and some fail", async () => {
    claimNextRunnableJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runPeopleGhlPush.mockResolvedValue(
      ghlResult({
        succeededPersonIds: ["p1"],
        failedPersonIds: ["p2"],
        failed_people: ["Jane Doe"],
        errors: 1,
        pushed: 1,
      })
    );

    await POST(req());

    expect(finishJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ status: "partial", succeeded: 1, failed: 1 })
    );
    const failuresArg = finishJob.mock.calls[0][1].failures;
    expect(failuresArg).toEqual([{ name: "Jane Doe", reason: expect.any(String) }]);
  });

  it("dispatches an EmailBison workspace people job", async () => {
    claimNextRunnableJob
      .mockResolvedValueOnce(makeJob({ platform: "emailbison_people", entity: "people" }))
      .mockResolvedValue(null);
    runPeopleAddToEmailBison.mockResolvedValue({
      total_matched: 1,
      pushed: 1,
      created: 1,
      updated: 0,
      errors: 0,
      failed_people: [],
      failed: [],
      succeededPersonIds: ["p1"],
      failedPersonIds: [],
      nextOffset: 1,
      done: true,
    });

    await POST(req());

    expect(runPeopleAddToEmailBison).toHaveBeenCalledTimes(1);
    expect(runPeopleGhlPush).not.toHaveBeenCalled();
    expect(logActivity).toHaveBeenCalledWith("emailbison.push", expect.any(Object), expect.any(Object));
  });

  it("dispatches an EmailBison campaign companies job with campaignId", async () => {
    claimNextRunnableJob
      .mockResolvedValueOnce(
        makeJob({ platform: "emailbison_campaign", entity: "companies", action: "campaign", campaignId: "camp-9" })
      )
      .mockResolvedValue(null);
    runCompaniesAddToCampaign.mockResolvedValue({
      total_matched: 3,
      attached: 3,
      created: 3,
      updated: 0,
      errors: 0,
      failed_people: [],
      failed: [],
      succeededPersonIds: ["p1", "p2", "p3"],
      failedPersonIds: [],
      nextOffset: 3,
      done: true,
    });

    await POST(req());

    const [, , campaignId] = runCompaniesAddToCampaign.mock.calls[0];
    expect(campaignId).toBe("camp-9");
    expect(finishJob).toHaveBeenCalledWith("job-1", expect.objectContaining({ status: "succeeded" }));
  });
});

describe("push-worker auto-launch on complete (launchOnComplete)", () => {
  function campaignResult(overrides: Record<string, unknown> = {}) {
    return {
      total_matched: 2,
      attached: 2,
      created: 2,
      updated: 0,
      errors: 0,
      failed_people: [],
      failed: [],
      succeededPersonIds: ["p1", "p2"],
      failedPersonIds: [],
      nextOffset: 2,
      done: true,
      ...overrides,
    };
  }

  const campaignJob = (overrides: Partial<PushJob> = {}) =>
    makeJob({
      platform: "emailbison_campaign",
      entity: "people",
      action: "campaign",
      campaignId: "camp-9",
      options: { launchOnComplete: true },
      ...overrides,
    });

  it("resumes the campaign on the terminal tick when launchOnComplete and succeeded>=1", async () => {
    claimNextRunnableJob.mockResolvedValueOnce(campaignJob()).mockResolvedValue(null);
    runPeopleAddToCampaign.mockResolvedValue(campaignResult());

    await POST(req());

    expect(finishJob).toHaveBeenCalledWith("job-1", expect.objectContaining({ status: "succeeded" }));
    expect(resumeCampaign).toHaveBeenCalledTimes(1);
    const [credentials, campaignId] = resumeCampaign.mock.calls[0];
    expect(credentials).toEqual({ apiKey: "key", workspaceId: "ws" });
    expect(campaignId).toBe("camp-9");
  });

  it("does NOT resume when succeeded===0 (guards the empty-campaign 400 / #106 drop)", async () => {
    claimNextRunnableJob
      .mockResolvedValueOnce(campaignJob())
      .mockResolvedValue(null);
    runPeopleAddToCampaign.mockResolvedValue(
      campaignResult({
        succeededPersonIds: [],
        failedPersonIds: ["p1", "p2"],
        failed: [
          { name: "p1", reason: "already in another sequence" },
          { name: "p2", reason: "already in another sequence" },
        ],
        attached: 0,
        created: 0,
        errors: 2,
      })
    );

    await POST(req());

    expect(finishJob).toHaveBeenCalledWith("job-1", expect.objectContaining({ status: "failed" }));
    expect(resumeCampaign).not.toHaveBeenCalled();
  });

  it("does NOT resume when launchOnComplete is absent", async () => {
    claimNextRunnableJob.mockResolvedValueOnce(campaignJob({ options: {} })).mockResolvedValue(null);
    runPeopleAddToCampaign.mockResolvedValue(campaignResult());

    await POST(req());

    expect(resumeCampaign).not.toHaveBeenCalled();
  });

  it("does not fail the job when the auto-launch throws (leads were attached)", async () => {
    claimNextRunnableJob.mockResolvedValueOnce(campaignJob()).mockResolvedValue(null);
    runPeopleAddToCampaign.mockResolvedValue(campaignResult());
    resumeCampaign.mockRejectedValue(new Error("resume 500"));

    const res = await POST(req());
    expect(res.status).toBe(200);

    // Job still finished on its real attach outcome; the failed launch is
    // swallowed, not surfaced as a job failure.
    expect(finishJob).toHaveBeenCalledWith("job-1", expect.objectContaining({ status: "succeeded" }));
    expect(resumeCampaign).toHaveBeenCalledTimes(1);
  });
});

describe("push-worker continue + self-chain", () => {
  it("updates progress and self-chains when a tick is not done", async () => {
    claimNextRunnableJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runPeopleGhlPush.mockResolvedValue(
      ghlResult({ done: false, nextOffset: 100, succeededPersonIds: ["p1"], failedPersonIds: [], pushed: 1, created: 1, updated: 0 })
    );

    const res = await POST(req());
    const body = await res.json();

    expect(updateJobProgress).toHaveBeenCalledWith("job-1", {
      total: 2,
      processed: 100,
      succeeded: 1,
      created: 1,
      updated: 0,
      failed: 0,
      cursor: { offset: 100 },
    });
    expect(finishJob).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
    expect(body.chained).toBe(true);

    // The self-chain must carry the in-progress job id so the next invocation
    // resumes *this* row directly (keeping its client `running` so a
    // concurrent invocation can pick up a different client) rather than
    // re-claiming it.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null));
    await (after.mock.calls[0][0] as () => void | Promise<void>)();
    const [, init] = fetchSpy.mock.calls[0];
    expect(init?.method).toBe("POST");
    expect(JSON.parse(init?.body as string)).toEqual({ jobId: "job-1" });
    fetchSpy.mockRestore();
  });

  it("resumes accumulated totals from the job row and offset from the cursor", async () => {
    claimNextRunnableJob
      .mockResolvedValueOnce(makeJob({ succeeded: 5, failed: 1, cursor: { offset: 50 } }))
      .mockResolvedValue(null);
    runPeopleGhlPush.mockResolvedValue(
      ghlResult({ done: true, nextOffset: 52, succeededPersonIds: ["p51"], failedPersonIds: [], pushed: 1 })
    );

    await POST(req());

    expect(runPeopleGhlPush.mock.calls[0][3].offset).toBe(50);
    // cumulative: 5 + 1 = 6 succeeded, 1 + 0 = 1 failed → partial
    expect(finishJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ status: "partial", succeeded: 6, failed: 1 })
    );
  });
});

describe("push-worker resume by jobId (self-chain)", () => {
  const resumeReq = (jobId: string) =>
    new Request("http://localhost/api/internal/push-worker", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId }),
    });

  it("resumes the posted running job directly, from its cursor, without claiming it", async () => {
    getPushJob.mockResolvedValue(makeJob({ id: "job-7", cursor: { offset: 20 } }));
    // No claim result — so the only job that can be processed is the resumed
    // one; claim is used solely to look for further work after it finishes.
    claimNextRunnableJob.mockResolvedValue(null);
    runPeopleGhlPush.mockResolvedValue(
      ghlResult({ done: true, nextOffset: 22, succeededPersonIds: ["p21"], failedPersonIds: [] })
    );

    const res = await POST(resumeReq("job-7"));
    expect(res.status).toBe(200);

    expect(getPushJob).toHaveBeenCalledWith("job-7");
    expect(runPeopleGhlPush).toHaveBeenCalledTimes(1);
    expect(runPeopleGhlPush.mock.calls[0][3].offset).toBe(20);
    expect(finishJob).toHaveBeenCalledWith("job-7", expect.objectContaining({ status: "succeeded" }));
  });

  it("skips a posted job that is already terminal and falls through to the claim path", async () => {
    getPushJob.mockResolvedValue(makeJob({ id: "job-8", status: "succeeded" }));
    claimNextRunnableJob.mockResolvedValue(null);

    const res = await POST(resumeReq("job-8"));
    expect(res.status).toBe(200);

    expect(getPushJob).toHaveBeenCalledWith("job-8");
    expect(claimNextRunnableJob).toHaveBeenCalledTimes(1);
    expect(runPeopleGhlPush).not.toHaveBeenCalled();
  });
});

describe("push-worker error handling", () => {
  it("finishes a job failed when its tick throws, without crashing the invocation", async () => {
    claimNextRunnableJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runPeopleGhlPush.mockRejectedValue(new Error("EmailBison exploded"));

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(finishJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ status: "failed", error: "EmailBison exploded" })
    );
  });

  it("serializes a thrown non-Error object diagnosably, not as '[object Object]'", async () => {
    claimNextRunnableJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    // The bare {message} shape supabase-js can return on an oversized request —
    // String()'ing it would collapse to the useless "[object Object]" that
    // masked real failures in the job's error column.
    runPeopleGhlPush.mockRejectedValue({ message: "", code: "PGRST100" });

    const res = await POST(req());
    expect(res.status).toBe(200);
    const errorArg = finishJob.mock.calls[0][1].error as string;
    expect(errorArg).not.toBe("[object Object]");
    expect(errorArg).toContain("PGRST100");
  });

  it("finishes a job failed when its client no longer exists", async () => {
    claimNextRunnableJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    getClientById.mockResolvedValue(null);

    await POST(req());
    expect(runPeopleGhlPush).not.toHaveBeenCalled();
    expect(finishJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ status: "failed", error: expect.stringContaining("not found") })
    );
  });
});
