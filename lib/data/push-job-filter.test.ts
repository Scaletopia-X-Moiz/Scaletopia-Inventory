import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getPeople } from "@/lib/data/people";
import { getCompanies } from "@/lib/data/companies";
import { createPushJob, recordJobPeople } from "@/lib/data/push-jobs";

// The `pushJobId` filter (#123) restricts People/Companies to exactly the
// records a push run touched, via the per-record tags in `push_job_records`.
// These tests build an isolated run (client + company + tagged people) and
// assert both entity lists resolve to precisely that set — and that it stays
// stable when a later run tags different people.
const TEST_PREFIX = "__test-push-job-filter__";

function testDomain(slug: string): string {
  return `${TEST_PREFIX}${slug}.example.com`;
}
function testLinkedin(slug: string): string {
  return `https://linkedin.com/in/${TEST_PREFIX}${slug}`;
}

async function cleanupAll() {
  const { data: clients } = await supabaseAdmin
    .from("clients")
    .select("id")
    .like("slug", `${TEST_PREFIX}%`);
  const clientIds = (clients ?? []).map((c) => (c as { id: string }).id);
  if (clientIds.length > 0) {
    const { data: jobs } = await supabaseAdmin.from("push_jobs").select("id").in("client_id", clientIds);
    const jobIds = (jobs ?? []).map((j) => (j as { id: string }).id);
    if (jobIds.length > 0) {
      await supabaseAdmin.from("push_job_records").delete().in("push_job_id", jobIds);
    }
    await supabaseAdmin.from("push_jobs").delete().in("client_id", clientIds);
  }
  // people (FK child) before companies (FK parent).
  await supabaseAdmin.from("people").delete().like("linkedin_url", `%${TEST_PREFIX}%`);
  await supabaseAdmin.from("companies").delete().like("domain", `${TEST_PREFIX}%`);
  await supabaseAdmin.from("clients").delete().like("slug", `${TEST_PREFIX}%`);
}

beforeAll(cleanupAll);
afterAll(cleanupAll);

let counter = 0;
function unique(label: string): string {
  counter++;
  return `${TEST_PREFIX}${label}-${counter}`;
}

async function insertClient(): Promise<string> {
  const slug = unique("client");
  const { data, error } = await supabaseAdmin
    .from("clients")
    .insert({ slug, name: `Push Filter Co ${slug}` })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function insertCompany(slug: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("companies")
    .insert({ domain: testDomain(slug), company_name: `Company ${slug}` })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function insertPerson(slug: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("people")
    .insert({
      linkedin_url: testLinkedin(slug),
      full_name: `Person ${slug}`,
      source: "clay",
      ...overrides,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

describe("pushJobId filter", () => {
  it("restricts People to exactly the job's tagged records, with an outcome sub-scope", async () => {
    const clientId = await insertClient();
    const companyId = await insertCompany("co");

    const succeededA = await insertPerson("succeeded-a", { company_id: companyId });
    const succeededB = await insertPerson("succeeded-b", { company_id: companyId });
    const failedC = await insertPerson("failed-c");
    // An untagged person on the same client, to prove only tagged rows match.
    await insertPerson("untagged-d", { company_id: companyId });

    const job = await createPushJob({ clientId, platform: "ghl", entity: "people", filters: {} });
    await recordJobPeople(job.id, "people", [
      { personId: succeededA, outcome: "succeeded" },
      { personId: succeededB, outcome: "succeeded" },
      { personId: failedC, outcome: "failed" },
    ]);

    const all = await getPeople({ pushJobId: job.id }, 1, 100);
    expect(new Set(all.rows.map((r) => r.id))).toEqual(new Set([succeededA, succeededB, failedC]));
    expect(all.total).toBe(3);

    const succeededOnly = await getPeople({ pushJobId: job.id, pushJobOutcome: "succeeded" }, 1, 100);
    expect(new Set(succeededOnly.rows.map((r) => r.id))).toEqual(new Set([succeededA, succeededB]));
    expect(succeededOnly.total).toBe(2);
  });

  it("restricts Companies to those linked to the job's tagged people", async () => {
    const clientId = await insertClient();
    const linkedCompany = await insertCompany("linked");
    const otherCompany = await insertCompany("other");

    const p1 = await insertPerson("c-linked-1", { company_id: linkedCompany });
    const p2 = await insertPerson("c-linked-2", { company_id: linkedCompany });
    // A tagged person with no company must not error or leak a company row.
    const p3 = await insertPerson("c-unlinked");
    // A person at otherCompany that the job never touched — its company must
    // not appear.
    await insertPerson("c-other", { company_id: otherCompany });

    const job = await createPushJob({ clientId, platform: "ghl", entity: "companies", filters: {} });
    await recordJobPeople(job.id, "people", [
      { personId: p1, outcome: "succeeded" },
      { personId: p2, outcome: "succeeded" },
      { personId: p3, outcome: "succeeded" },
    ]);

    const companies = await getCompanies({ pushJobId: job.id }, 1, 100);
    expect(new Set(companies.rows.map((r) => r.id))).toEqual(new Set([linkedCompany]));
    expect(companies.total).toBe(1);
  });

  it("stays stable after a later push to the same client tags different people", async () => {
    const clientId = await insertClient();
    const firstA = await insertPerson("stable-a");
    const firstB = await insertPerson("stable-b");

    const firstJob = await createPushJob({ clientId, platform: "ghl", entity: "people", filters: {} });
    await recordJobPeople(firstJob.id, "people", [
      { personId: firstA, outcome: "succeeded" },
      { personId: firstB, outcome: "succeeded" },
    ]);

    // A second run to the SAME client tags a different person.
    const laterC = await insertPerson("stable-c");
    const secondJob = await createPushJob({ clientId, platform: "ghl", entity: "people", filters: {} });
    await recordJobPeople(secondJob.id, "people", [{ personId: laterC, outcome: "succeeded" }]);

    const first = await getPeople({ pushJobId: firstJob.id }, 1, 100);
    expect(new Set(first.rows.map((r) => r.id))).toEqual(new Set([firstA, firstB]));
  });

  it("intersects pushJobId with other standard filters", async () => {
    const clientId = await insertClient();
    const keep = await insertPerson("intersect-keep", { job_title: "Chief Marketing Officer" });
    const drop = await insertPerson("intersect-drop", { job_title: "Software Engineer" });

    const job = await createPushJob({ clientId, platform: "ghl", entity: "people", filters: {} });
    await recordJobPeople(job.id, "people", [
      { personId: keep, outcome: "succeeded" },
      { personId: drop, outcome: "succeeded" },
    ]);

    const filtered = await getPeople({ pushJobId: job.id, jobTitle: "marketing" }, 1, 100);
    expect(new Set(filtered.rows.map((r) => r.id))).toEqual(new Set([keep]));
  });

  it("returns an empty set for a job with no tagged records", async () => {
    const clientId = await insertClient();
    const job = await createPushJob({ clientId, platform: "ghl", entity: "people", filters: {} });

    const people = await getPeople({ pushJobId: job.id }, 1, 100);
    expect(people.total).toBe(0);
    expect(people.rows).toEqual([]);

    const companies = await getCompanies({ pushJobId: job.id }, 1, 100);
    expect(companies.total).toBe(0);
  });
});
