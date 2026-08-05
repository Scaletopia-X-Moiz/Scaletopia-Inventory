import { describe, expect, it, vi, beforeEach } from "vitest";
import type { PushJob } from "@/lib/data/push-jobs";
import type { ClientRow } from "@/lib/data/clients";

const { after } = vi.hoisted(() => ({ after: vi.fn() }));
vi.mock("next/server", () => ({ after }));

const { getResumableJob, updateJobProgress, finishJob, recordJobPeople } = vi.hoisted(() => ({
  getResumableJob: vi.fn(),
  updateJobProgress: vi.fn(),
  finishJob: vi.fn(),
  recordJobPeople: vi.fn(),
}));
vi.mock("@/lib/data/push-jobs", () => ({ getResumableJob, updateJobProgress, finishJob, recordJobPeople }));

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
    tagAppended: 0,
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
});

describe("push-worker auth", () => {
  it("skips the check when no secret env var is set", async () => {
    getResumableJob.mockResolvedValue(null);
    const res = await POST(req());
    expect(res.status).toBe(200);
  });

  it("401s when CRON_SECRET is set but the header is wrong", async () => {
    process.env.CRON_SECRET = "s3cret";
    const res = await GET(new Request("http://localhost/api/internal/push-worker"));
    expect(res.status).toBe(401);
    expect(getResumableJob).not.toHaveBeenCalled();
  });

  it("accepts a matching x-worker-secret header", async () => {
    process.env.PUSH_WORKER_SECRET = "wsecret";
    getResumableJob.mockResolvedValue(null);
    const res = await POST(
      new Request("http://localhost/api/internal/push-worker", {
        method: "POST",
        headers: { "x-worker-secret": "wsecret" },
      })
    );
    expect(res.status).toBe(200);
  });
});

describe("push-worker dispatch + finish", () => {
  it("dispatches a GHL job, records people, finishes succeeded, logs activity, no self-chain", async () => {
    getResumableJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runPeopleGhlPush.mockResolvedValue(ghlResult());

    const res = await POST(req());
    expect(res.status).toBe(200);

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
      succeeded: 2,
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
    getResumableJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
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
    getResumableJob
      .mockResolvedValueOnce(makeJob({ platform: "emailbison_people", entity: "people" }))
      .mockResolvedValue(null);
    runPeopleAddToEmailBison.mockResolvedValue({
      total_matched: 1,
      pushed: 1,
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
    getResumableJob
      .mockResolvedValueOnce(
        makeJob({ platform: "emailbison_campaign", entity: "companies", action: "campaign", campaignId: "camp-9" })
      )
      .mockResolvedValue(null);
    runCompaniesAddToCampaign.mockResolvedValue({
      total_matched: 3,
      attached: 3,
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

describe("push-worker continue + self-chain", () => {
  it("updates progress and self-chains when a tick is not done", async () => {
    getResumableJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runPeopleGhlPush.mockResolvedValue(
      ghlResult({ done: false, nextOffset: 100, succeededPersonIds: ["p1"], failedPersonIds: [], pushed: 1 })
    );

    const res = await POST(req());
    const body = await res.json();

    expect(updateJobProgress).toHaveBeenCalledWith("job-1", {
      total: 2,
      processed: 100,
      succeeded: 1,
      failed: 0,
      cursor: { offset: 100 },
    });
    expect(finishJob).not.toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
    expect(body.chained).toBe(true);
  });

  it("resumes accumulated totals from the job row and offset from the cursor", async () => {
    getResumableJob
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

describe("push-worker error handling", () => {
  it("finishes a job failed when its tick throws, without crashing the invocation", async () => {
    getResumableJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    runPeopleGhlPush.mockRejectedValue(new Error("EmailBison exploded"));

    const res = await POST(req());
    expect(res.status).toBe(200);
    expect(finishJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ status: "failed", error: "EmailBison exploded" })
    );
  });

  it("finishes a job failed when its client no longer exists", async () => {
    getResumableJob.mockResolvedValueOnce(makeJob()).mockResolvedValue(null);
    getClientById.mockResolvedValue(null);

    await POST(req());
    expect(runPeopleGhlPush).not.toHaveBeenCalled();
    expect(finishJob).toHaveBeenCalledWith(
      "job-1",
      expect.objectContaining({ status: "failed", error: expect.stringContaining("not found") })
    );
  });
});
