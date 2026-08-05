import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  claimNextRunnableJob,
  createPushJob,
  finishJob,
  getPushJob,
  listPushJobs,
  recordJobPeople,
  updateJobProgress,
} from "@/lib/data/push-jobs";

const TEST_PREFIX = "__test-push-jobs__";

function testLinkedin(slug: string): string {
  return `https://linkedin.com/in/${TEST_PREFIX}${slug}`;
}

async function cleanupAll() {
  const { data: clients } = await supabaseAdmin.from("clients").select("id").like("slug", `${TEST_PREFIX}%`);
  const clientIds = (clients ?? []).map((c) => (c as { id: string }).id);
  if (clientIds.length > 0) {
    const { data: jobs } = await supabaseAdmin.from("push_jobs").select("id").in("client_id", clientIds);
    const jobIds = (jobs ?? []).map((j) => (j as { id: string }).id);
    if (jobIds.length > 0) {
      await supabaseAdmin.from("push_job_records").delete().in("push_job_id", jobIds);
    }
    await supabaseAdmin.from("push_jobs").delete().in("client_id", clientIds);
  }
  await supabaseAdmin.from("people").delete().like("linkedin_url", `%${TEST_PREFIX}%`);
  await supabaseAdmin.from("clients").delete().like("slug", `${TEST_PREFIX}%`);
}

beforeAll(cleanupAll);
afterAll(cleanupAll);

let counter = 0;
function unique(label: string): string {
  counter++;
  return `${TEST_PREFIX}${label}-${counter}`;
}

async function insertClient(name: string): Promise<string> {
  const slug = unique("client");
  const { data, error } = await supabaseAdmin.from("clients").insert({ slug, name }).select("id").single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function insertPerson(fullName: string): Promise<string> {
  const slug = unique("person");
  const { data, error } = await supabaseAdmin
    .from("people")
    .insert({ linkedin_url: testLinkedin(slug), full_name: fullName })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/** Empties the runnable queue so a claim/serialization assertion sees only the
 * rows the test just created. Per-client serialization means one claim pass
 * leaves a client's other queued jobs behind (its first is now running), so
 * each claimed job is finished to free its client and let the loop continue. */
async function drainQueue(): Promise<void> {
  let job = await claimNextRunnableJob();
  while (job) {
    await finishJob(job.id, { status: "canceled", succeeded: 0, failed: 0 });
    job = await claimNextRunnableJob();
  }
}

describe("push-jobs data access", () => {
  it("creates a queued job with the trigger-time filter/options snapshot", async () => {
    const clientId = await insertClient(unique("Client"));

    const job = await createPushJob({
      clientId,
      platform: "emailbison_people",
      entity: "people",
      action: "workspace",
      niche: ["saas"],
      filters: { niche: ["saas"] },
      options: { existingLeadBehavior: "skip" },
      triggeredByEmail: "actor@example.com",
    });

    expect(job.status).toBe("queued");
    expect(job.clientId).toBe(clientId);
    expect(job.platform).toBe("emailbison_people");
    expect(job.niche).toEqual(["saas"]);
    expect(job.filters).toEqual({ niche: ["saas"] });
    expect(job.options).toEqual({ existingLeadBehavior: "skip" });
    expect(job.triggeredByEmail).toBe("actor@example.com");
    expect(job.total).toBe(0);
    expect(job.processed).toBe(0);

    const fetched = await getPushJob(job.id);
    expect(fetched?.id).toBe(job.id);
  });

  it("returns null for a nonexistent job", async () => {
    const fetched = await getPushJob("00000000-0000-0000-0000-000000000000");
    expect(fetched).toBeNull();
  });

  it("claims the oldest queued job whose client is idle and flips it to running", async () => {
    await drainQueue();
    const clientId = await insertClient(unique("Client"));

    const older = await createPushJob({ clientId, platform: "ghl", entity: "people", filters: {} });
    await createPushJob({ clientId, platform: "ghl", entity: "people", filters: {} });

    const claimed = await claimNextRunnableJob();

    expect(claimed?.id).toBe(older.id);
    expect(claimed?.status).toBe("running");
    expect(claimed?.startedAt).not.toBeNull();

    const refetched = await getPushJob(older.id);
    expect(refetched?.status).toBe("running");
  });

  it("serializes a second push to the same client behind the first, then auto-starts it", async () => {
    await drainQueue();
    const clientId = await insertClient(unique("Client"));

    const first = await createPushJob({ clientId, platform: "ghl", entity: "people", filters: {} });
    const second = await createPushJob({ clientId, platform: "ghl", entity: "people", filters: {} });

    const claimedFirst = await claimNextRunnableJob();
    expect(claimedFirst?.id).toBe(first.id);

    // The client now has a running job, so the second push is not claimable —
    // no other clients are queued, so the claim comes back empty.
    expect(await claimNextRunnableJob()).toBeNull();
    expect((await getPushJob(second.id))?.status).toBe("queued");

    // Finishing the first frees the client; the next claim auto-starts the second.
    await finishJob(first.id, { status: "succeeded", succeeded: 1, failed: 0 });
    const claimedSecond = await claimNextRunnableJob();
    expect(claimedSecond?.id).toBe(second.id);
    expect(claimedSecond?.status).toBe("running");
  });

  it("lets two different clients run concurrently", async () => {
    await drainQueue();
    const clientA = await insertClient(unique("Client A"));
    const clientB = await insertClient(unique("Client B"));

    const jobA = await createPushJob({ clientId: clientA, platform: "ghl", entity: "people", filters: {} });
    const jobB = await createPushJob({ clientId: clientB, platform: "ghl", entity: "people", filters: {} });

    const first = await claimNextRunnableJob();
    expect(first?.id).toBe(jobA.id);

    // A is running, but B is a different client — its push may start alongside.
    const second = await claimNextRunnableJob();
    expect(second?.id).toBe(jobB.id);
    expect(second?.status).toBe("running");
  });

  it("respects the max_concurrent cap across all clients", async () => {
    await drainQueue();
    const clientA = await insertClient(unique("Client A"));
    const clientB = await insertClient(unique("Client B"));

    await createPushJob({ clientId: clientA, platform: "ghl", entity: "people", filters: {} });
    await createPushJob({ clientId: clientB, platform: "ghl", entity: "people", filters: {} });

    // With a cap of 1, the first claim runs but the second is throttled even
    // though it belongs to an idle client.
    expect(await claimNextRunnableJob(1)).not.toBeNull();
    expect(await claimNextRunnableJob(1)).toBeNull();
  });

  it("updates progress counters mid-run", async () => {
    const clientId = await insertClient(unique("Client"));
    const job = await createPushJob({ clientId, platform: "ghl", entity: "people", filters: {} });

    await updateJobProgress(job.id, { total: 100, processed: 40, succeeded: 38, failed: 2 });

    const updated = await getPushJob(job.id);
    expect(updated?.total).toBe(100);
    expect(updated?.processed).toBe(40);
    expect(updated?.succeeded).toBe(38);
    expect(updated?.failed).toBe(2);
  });

  it("finishes a job with a terminal status and failure list", async () => {
    const clientId = await insertClient(unique("Client"));
    const job = await createPushJob({ clientId, platform: "ghl", entity: "people", filters: {} });

    await finishJob(job.id, {
      status: "partial",
      succeeded: 8,
      failed: 2,
      failures: [{ name: "Jane Doe", reason: "duplicate email" }],
    });

    const finished = await getPushJob(job.id);
    expect(finished?.status).toBe("partial");
    expect(finished?.succeeded).toBe(8);
    expect(finished?.failed).toBe(2);
    expect(finished?.failures).toEqual([{ name: "Jane Doe", reason: "duplicate email" }]);
    expect(finished?.finishedAt).not.toBeNull();
  });

  it("lists jobs newest first, filterable by client/platform/status", async () => {
    const clientName = unique("Client");
    const clientId = await insertClient(clientName);
    const otherClientId = await insertClient(unique("Other Client"));

    const first = await createPushJob({ clientId, platform: "ghl", entity: "people", filters: {} });
    const second = await createPushJob({ clientId, platform: "emailbison_people", entity: "people", filters: {} });
    await createPushJob({ clientId: otherClientId, platform: "ghl", entity: "people", filters: {} });
    await finishJob(first.id, { status: "succeeded", succeeded: 1, failed: 0 });

    const { rows, total } = await listPushJobs({ clientId });
    expect(total).toBe(2);
    expect(rows[0].id).toBe(second.id);
    expect(rows[1].id).toBe(first.id);
    // Rows are joined to their client so the Push Activity panel (#122) can
    // show the client name without a second fetch.
    expect(rows[0].client).toEqual({ id: clientId, name: clientName });

    const { rows: platformRows, total: platformTotal } = await listPushJobs({
      clientId,
      platform: "emailbison_people",
    });
    expect(platformTotal).toBe(1);
    expect(platformRows[0].id).toBe(second.id);

    const { rows: statusRows, total: statusTotal } = await listPushJobs({ clientId, status: "succeeded" });
    expect(statusTotal).toBe(1);
    expect(statusRows[0].id).toBe(first.id);
  });

  it("tags pushed people with the job id, upserting on repeat reports", async () => {
    const clientId = await insertClient(unique("Client"));
    const job = await createPushJob({ clientId, platform: "ghl", entity: "people", filters: {} });
    const personA = await insertPerson("Person A");
    const personB = await insertPerson("Person B");

    await recordJobPeople(job.id, [
      { personId: personA, outcome: "succeeded" },
      { personId: personB, outcome: "failed" },
    ]);
    await recordJobPeople(job.id, [{ personId: personB, outcome: "succeeded" }]);

    const { data, error } = await supabaseAdmin
      .from("push_job_records")
      .select("person_id,outcome")
      .eq("push_job_id", job.id)
      .order("person_id", { ascending: true });
    if (error) throw error;

    const byPerson = new Map((data ?? []).map((r) => [(r as { person_id: string }).person_id, (r as { outcome: string }).outcome]));
    expect(byPerson.get(personA)).toBe("succeeded");
    expect(byPerson.get(personB)).toBe("succeeded");
  });

  it("is a no-op when recording an empty outcomes list", async () => {
    const clientId = await insertClient(unique("Client"));
    const job = await createPushJob({ clientId, platform: "ghl", entity: "people", filters: {} });

    await expect(recordJobPeople(job.id, [])).resolves.toBeUndefined();
  });
});
