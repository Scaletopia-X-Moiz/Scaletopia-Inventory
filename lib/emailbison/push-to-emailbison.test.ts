import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  runPeopleAddToEmailBison,
  runCompaniesAddToEmailBison,
  runPeopleAddToCampaign,
  runCompaniesAddToCampaign,
} from "@/lib/emailbison/push-to-emailbison";
import { clearEmailBisonCustomVariablesCache, getEmailBisonCustomVariables } from "@/lib/emailbison/custom-variables";
import { includeOnly } from "@/lib/data/include-exclude";
import { resolveDefaultFieldMapping } from "@/lib/push/resolve-default-field-mapping";
import type { ClientRow } from "@/lib/data/clients";
import type { EmailBisonStandardFieldMapping } from "@/lib/emailbison/types";

const TEST_PREFIX = "__test-emailbison-push__";
const WORKSPACE = "https://dedi.emailbison.test";

function testLinkedin(slug: string): string {
  return `https://linkedin.com/in/${TEST_PREFIX}${slug}`;
}

function testDomain(slug: string): string {
  return `${TEST_PREFIX}${slug}.example.com`;
}

/** platform_pushes has plain (non-cascading) FKs to both people and clients,
 * so its rows for this test's people/clients must be deleted before either of
 * them — same FK ordering hazard as lib/ghl/push-to-ghl.test.ts's
 * cleanupAll. Companies (the people FK parent) go last. */
async function cleanupAll() {
  const [{ data: people }, { data: clients }] = await Promise.all([
    supabaseAdmin.from("people").select("id").like("linkedin_url", `%${TEST_PREFIX}%`),
    supabaseAdmin.from("clients").select("id").like("slug", `${TEST_PREFIX}%`),
  ]);
  const personIds = (people ?? []).map((p) => p.id as string);
  const clientIds = (clients ?? []).map((c) => c.id as string);

  if (personIds.length > 0) {
    await supabaseAdmin.from("platform_pushes").delete().in("person_id", personIds);
  }
  if (clientIds.length > 0) {
    await supabaseAdmin.from("platform_pushes").delete().in("client_id", clientIds);
  }
  await supabaseAdmin.from("people").delete().like("linkedin_url", `%${TEST_PREFIX}%`);
  await supabaseAdmin.from("clients").delete().like("slug", `${TEST_PREFIX}%`);
  await supabaseAdmin.from("companies").delete().like("domain", `${TEST_PREFIX}%`);
}

let testActor: { id: string; email: string };
let otherActor: { id: string; email: string };

async function createTestActor(slug: string): Promise<{ id: string; email: string }> {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: `${TEST_PREFIX}${slug}-${Date.now()}@example.com`,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("failed to create test actor");
  return { id: data.user.id, email: data.user.email! };
}

beforeAll(async () => {
  await cleanupAll();
  testActor = await createTestActor("actor");
  otherActor = await createTestActor("other-actor");
});
afterAll(async () => {
  await cleanupAll();
  if (testActor) await supabaseAdmin.auth.admin.deleteUser(testActor.id);
  if (otherActor) await supabaseAdmin.auth.admin.deleteUser(otherActor.id);
});

// ensureCustomVariablesExist patches newly-created variables into
// custom-variables.ts's module-level cache (keyed by workspace id, shared
// across every test in this file via the WORKSPACE constant) — clear it
// between tests so one test's mocked variables can't leak into another's.
afterEach(() => {
  clearEmailBisonCustomVariablesCache();
});

let counter = 0;
function unique(label: string): string {
  counter++;
  return `${TEST_PREFIX}${label}-${counter}`;
}

interface SeedPerson {
  slug: string;
  email?: string | null;
  fullName?: string;
  companyId?: string;
}

async function seedPeople(niche: string, rows: SeedPerson[]) {
  const { error } = await supabaseAdmin.from("people").insert(
    rows.map((r) => ({
      linkedin_url: testLinkedin(`${niche}-${r.slug}`),
      full_name: r.fullName ?? `Bison Test ${r.slug}`,
      first_name: r.fullName ?? `Bison Test ${r.slug}`,
      last_name: r.slug,
      email: r.email === undefined ? `${TEST_PREFIX}${niche}-${r.slug}@example.com` : r.email,
      niche_tokens: [niche],
      source: "clay",
      company_name: "Acme Co",
      company_id: r.companyId,
    }))
  );
  if (error) throw error;
}

async function insertCompany(niche: string, slug: string, overrides: Record<string, unknown> = {}): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("companies")
    .insert({
      domain: testDomain(slug),
      company_name: `Bison Test Co ${slug}`,
      niche,
      ...overrides,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function insertClient(overrides: Record<string, unknown> = {}): Promise<ClientRow> {
  const slug = unique("client");
  const { data, error } = await supabaseAdmin
    .from("clients")
    .insert({
      slug,
      name: slug,
      emailbison_api_key: "test-api-key",
      emailbison_workspace_id: WORKSPACE,
      is_active: true,
      ...overrides,
    })
    .select("id,slug,name,ghl_api_key,ghl_location_id,emailbison_api_key,emailbison_workspace_id,is_active,updated_at")
    .single();
  if (error) throw error;
  const row = data as {
    id: string;
    slug: string;
    name: string;
    ghl_api_key: string | null;
    ghl_location_id: string | null;
    emailbison_api_key: string | null;
    emailbison_workspace_id: string | null;
    is_active: boolean;
    updated_at: string;
  };
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    ghlApiKey: row.ghl_api_key,
    ghlLocationId: row.ghl_location_id,
    emailbisonApiKey: row.emailbison_api_key,
    emailbisonWorkspaceId: row.emailbison_workspace_id,
    isActive: row.is_active,
    updatedAt: row.updated_at,
  };
}

let leadCounter = 0;

/** A fetchImpl that resolves every EmailBison endpoint this push touches:
 * empty custom-variable list, echoes back every lead it's given (upserted by
 * email) with a fresh id. */
function okFetch(): typeof fetch {
  return vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/custom-variables") && init?.method === "GET") {
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response;
    }
    if (u.endsWith("/api/custom-variables")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      leadCounter++;
      return {
        ok: true,
        status: 201,
        json: async () => ({ data: { id: leadCounter, name: body.name } }),
      } as unknown as Response;
    }
    if (u.endsWith("/api/leads/create-or-update/multiple")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const leads = (body.leads as Array<{ email: string }>).map((lead) => {
        leadCounter++;
        return { id: leadCounter, email: lead.email };
      });
      return { ok: true, status: 200, json: async () => ({ data: leads }) } as unknown as Response;
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as unknown as typeof fetch;
}

/** okFetch() plus capturing every lead upserted in `capturedLeads`, keyed by
 * email — lets a test inspect exactly what buildEmailBisonLeadPayload sent
 * for each candidate, e.g. to assert a mapping's skip/include choices. */
function okFetchCapturingLeads(capturedLeads: Record<string, unknown>[]): typeof fetch {
  return vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith("/api/custom-variables") && init?.method === "GET") {
      return { ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response;
    }
    if (u.endsWith("/api/leads/create-or-update/multiple")) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      const leads = (body.leads as Record<string, unknown>[]).map((lead) => {
        capturedLeads.push(lead);
        leadCounter++;
        return { id: leadCounter, email: lead.email };
      });
      return { ok: true, status: 200, json: async () => ({ data: leads }) } as unknown as Response;
    }
    throw new Error(`unexpected fetch to ${u}`);
  }) as unknown as typeof fetch;
}

describe("standardFieldMapping (issue #110)", () => {
  it("reproduces today's behavior when the mapping is omitted", async () => {
    const niche = unique("mapping-omitted");
    const companyId = await insertCompany(niche, "brand-omitted", { brand_name: "Acme" });
    await seedPeople(niche, [{ slug: "a", companyId }]);
    const client = await insertClient();
    const capturedLeads: Record<string, unknown>[] = [];

    await runPeopleAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl: okFetchCapturingLeads(capturedLeads),
    });

    expect(capturedLeads).toHaveLength(1);
    expect(capturedLeads[0].company_name).toBe("Acme");
    expect(capturedLeads[0].first_name).toBeTruthy();
  });

  it("sends the raw company_name when the mapping chooses company_name over brand_name", async () => {
    const niche = unique("mapping-company-name");
    const companyId = await insertCompany(niche, "brand-chosen", { brand_name: "Acme" });
    await seedPeople(niche, [{ slug: "a", companyId }]);
    const client = await insertClient();
    const capturedLeads: Record<string, unknown>[] = [];
    const mapping: EmailBisonStandardFieldMapping = {
      companyName: "company_name",
      firstName: "include",
      lastName: "include",
      email: "include",
      phone: "include",
      title: "include",
      website: "include",
    };

    await runPeopleAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl: okFetchCapturingLeads(capturedLeads),
      standardFieldMapping: mapping,
    });

    expect(capturedLeads).toHaveLength(1);
    expect(capturedLeads[0].company_name).toBe("Acme Co");
  });

  it("omits fields the mapping sets to skip", async () => {
    const niche = unique("mapping-skip");
    await seedPeople(niche, [{ slug: "a" }]);
    const client = await insertClient();
    const capturedLeads: Record<string, unknown>[] = [];
    const mapping: EmailBisonStandardFieldMapping = {
      companyName: "skip",
      firstName: "include",
      lastName: "include",
      email: "include",
      phone: "skip",
      title: "skip",
      website: "skip",
    };

    await runPeopleAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl: okFetchCapturingLeads(capturedLeads),
      standardFieldMapping: mapping,
    });

    expect(capturedLeads).toHaveLength(1);
    expect(capturedLeads[0].company_name).toBeNull();
    expect(capturedLeads[0].phone).toBeNull();
    expect(capturedLeads[0].title).toBeNull();
    expect(capturedLeads[0].website).toBeNull();
    expect(capturedLeads[0].first_name).toBeTruthy();
  });

  it("forwards the mapping through the campaign orchestrator too", async () => {
    const niche = unique("mapping-campaign");
    await seedPeople(niche, [{ slug: "a" }]);
    const client = await insertClient();
    const capturedLeads: Record<string, unknown>[] = [];
    const base = okFetchCapturingLeads(capturedLeads);
    const fetchImpl = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith(`/api/campaigns/${CAMPAIGN_ID}/leads/attach-leads`)) {
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      return (base as unknown as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;
    const mapping: EmailBisonStandardFieldMapping = {
      companyName: "skip",
      firstName: "include",
      lastName: "include",
      email: "include",
      phone: "include",
      title: "include",
      website: "include",
    };

    await runPeopleAddToCampaign({ niche: includeOnly([niche]) }, client, CAMPAIGN_ID, testActor, {
      fetchImpl,
      standardFieldMapping: mapping,
    });

    expect(capturedLeads).toHaveLength(1);
    expect(capturedLeads[0].company_name).toBeNull();
  });

  it("uses resolveDefaultFieldMapping's fallback default (from #108) when no brand_name is present in the pushed set", async () => {
    const niche = unique("mapping-default-fallback");
    await seedPeople(niche, [{ slug: "a" }]);
    const client = await insertClient();
    const capturedLeads: Record<string, unknown>[] = [];

    const { standardFields } = resolveDefaultFieldMapping({
      platform: "emailbison",
      records: [{ companyName: "Acme Co", brandName: null }],
    });
    expect(standardFields.companyName).toBe("company_name");

    await runPeopleAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl: okFetchCapturingLeads(capturedLeads),
      standardFieldMapping: standardFields,
    });

    expect(capturedLeads).toHaveLength(1);
    expect(capturedLeads[0].company_name).toBe("Acme Co");
  });
});

describe("runPeopleAddToEmailBison", () => {
  it("pushes every matched person and logs each to platform_pushes", async () => {
    const niche = unique("basic");
    await seedPeople(niche, [{ slug: "a" }, { slug: "b" }]);
    const client = await insertClient();
    const fetchImpl = okFetch();

    const result = await runPeopleAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor, { fetchImpl });

    expect(result.total_matched).toBe(2);
    expect(result.pushed).toBe(2);
    expect(result.errors).toBe(0);
    expect(result.failed_people).toEqual([]);

    const { data: people } = await supabaseAdmin
      .from("people")
      .select("id,pushed_to_emailbison,pushed_to_emailbison_at")
      .like("linkedin_url", `%${niche}%`);
    const personIds = (people ?? []).map((p) => p.id as string);
    for (const person of people!) {
      expect(person.pushed_to_emailbison).toBe(true);
      expect(person.pushed_to_emailbison_at).toBeTruthy();
    }
    const { data: pushRows } = await supabaseAdmin
      .from("platform_pushes")
      .select("platform,platform_contact_id,person_id,client_id,pushed_by_user_id,pushed_by_email")
      .in("person_id", personIds);
    expect(pushRows).toHaveLength(2);
    for (const row of pushRows!) {
      expect(row.platform).toBe("emailbison");
      expect(row.client_id).toBe(client.id);
      expect(row.platform_contact_id).toBeTruthy();
      expect(row.pushed_by_user_id).toBe(testActor.id);
      expect(row.pushed_by_email).toBe(testActor.email);
    }
  });

  it("re-pushes on a second run and overwrites the platform_pushes row (no dedupe)", async () => {
    const niche = unique("repeat");
    await seedPeople(niche, [{ slug: "a" }]);
    const client = await insertClient();

    const first = await runPeopleAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl: okFetch(),
    });
    expect(first.pushed).toBe(1);

    const second = await runPeopleAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl: okFetch(),
    });
    expect(second.pushed).toBe(1);

    const { data: person } = await supabaseAdmin
      .from("people")
      .select("id")
      .eq("linkedin_url", testLinkedin(`${niche}-a`))
      .single();
    const { data: pushRows } = await supabaseAdmin
      .from("platform_pushes")
      .select("id")
      .eq("person_id", person!.id as string);
    expect(pushRows).toHaveLength(1);
  });

  it("fails a record with no email without aborting the rest of the batch", async () => {
    const niche = unique("no-email");
    await seedPeople(niche, [
      { slug: "has-email" },
      { slug: "no-email", email: null, fullName: "No Email Person" },
    ]);
    const client = await insertClient();

    const result = await runPeopleAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl: okFetch(),
    });

    expect(result.total_matched).toBe(2);
    expect(result.pushed).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.failed_people).toContain("No Email Person");
    expect(result.failed).toContainEqual({
      name: "No Email Person",
      reason: "no email on record — EmailBison upserts leads by email",
    });
  });

  it("does not abort the batch when the bulk upsert call itself fails", async () => {
    const niche = unique("api-fail");
    await seedPeople(niche, [{ slug: "a" }]);
    const client = await insertClient();
    const fetchImpl = vi.fn().mockImplementation(async (url: unknown) => {
      const u = String(url);
      if (u.endsWith("/api/custom-variables")) {
        return { ok: true, status: 200, json: async () => ({ data: [] }) } as unknown as Response;
      }
      return { ok: false, status: 500, json: async () => ({ message: "down" }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await runPeopleAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor, { fetchImpl });

    expect(result.total_matched).toBe(1);
    expect(result.pushed).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toBeTruthy();
  });

  it("creates missing custom-variable names once per push, not once per person", async () => {
    const niche = unique("custom-vars");
    await seedPeople(niche, [{ slug: "a" }, { slug: "b" }, { slug: "c" }]);
    const client = await insertClient();

    const listCalls: string[] = [];
    const createCalls: string[] = [];
    const fetchImpl = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/custom-variables") && init?.method === "POST") {
        const body = JSON.parse((init?.body as string) ?? "{}");
        createCalls.push(body.name);
        leadCounter++;
        return {
          ok: true,
          status: 201,
          json: async () => ({ data: { id: leadCounter, name: body.name } }),
        } as unknown as Response;
      }
      if (u.endsWith("/api/custom-variables")) {
        listCalls.push(u);
        return {
          ok: true,
          status: 200,
          json: async () => ({ data: [{ id: 1, name: "existing_var" }] }),
        } as unknown as Response;
      }
      if (u.endsWith("/api/leads/create-or-update/multiple")) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        const leads = (body.leads as Array<{ email: string }>).map((lead) => {
          leadCounter++;
          return { id: leadCounter, email: lead.email };
        });
        return { ok: true, status: 200, json: async () => ({ data: leads }) } as unknown as Response;
      }
      throw new Error(`unexpected fetch to ${u}`);
    }) as unknown as typeof fetch;

    const result = await runPeopleAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl,
      customVariables: [
        { name: "existing_var", value: "x" },
        { name: "new_var", value: "y" },
      ],
    });

    expect(result.pushed).toBe(3);
    expect(listCalls).toHaveLength(1);
    expect(createCalls).toEqual(["new_var"]);

    // The newly-created variable must be visible to the UI's "existing
    // workspace variables" reference panel immediately, without a refetch —
    // ensureCustomVariablesExist patches it into the shared cache in place.
    const cached = await getEmailBisonCustomVariables(
      { apiKey: client.emailbisonApiKey!, workspaceId: client.emailbisonWorkspaceId! },
      { fetchImpl: vi.fn() }
    );
    expect(cached.map((v) => v.name)).toContain("new_var");
  });

  it("returns an all-zero result for an empty filter match", async () => {
    const niche = unique("empty");
    const client = await insertClient();
    const fetchImpl = okFetch();

    const result = await runPeopleAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor, { fetchImpl });

    expect(result).toEqual({
      total_matched: 0,
      pushed: 0,
      errors: 0,
      failed_people: [],
      failed: [],
      succeededPersonIds: [],
      failedPersonIds: [],
      nextOffset: 0,
      done: true,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when the client has no EmailBison credentials configured", async () => {
    const niche = unique("no-creds");
    const client = await insertClient({ emailbison_api_key: null, emailbison_workspace_id: null });

    await expect(
      runPeopleAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor)
    ).rejects.toThrow("EmailBison credentials");
  });

  it("reports progress through resolving, pushing, and done phases", async () => {
    const niche = unique("progress");
    await seedPeople(niche, [{ slug: "a" }, { slug: "b" }]);
    const client = await insertClient();
    const fetchImpl = okFetch();
    const progress: Array<{ phase: string; done: number; total: number }> = [];

    await runPeopleAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl,
      onProgress: (p) => progress.push({ phase: p.phase, done: p.done, total: p.total }),
    });

    expect(progress[0]).toEqual({ phase: "resolving", done: 0, total: 0 });
    expect(progress[1]).toEqual({ phase: "pushing", done: 0, total: 2 });
    const last = progress[progress.length - 1];
    expect(last).toEqual({ phase: "done", done: 2, total: 2 });
  });
});

describe("runCompaniesAddToEmailBison", () => {
  it("resolves matching Companies to every linked Person and pushes them", async () => {
    const niche = unique("companies");
    const companyId = await insertCompany(niche, "with-people");
    await seedPeople(niche, [
      { slug: "linked-a", companyId },
      { slug: "linked-b", companyId },
    ]);
    const client = await insertClient();
    const fetchImpl = okFetch();

    const result = await runCompaniesAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor, { fetchImpl });

    expect(result.total_matched).toBe(2);
    expect(result.pushed).toBe(2);
    expect(result.errors).toBe(0);
  });

  it("yields an all-zero result for a Company with no linked People", async () => {
    const niche = unique("companies-empty");
    await insertCompany(niche, "no-people");
    const client = await insertClient();
    const fetchImpl = okFetch();

    const result = await runCompaniesAddToEmailBison({ niche: includeOnly([niche]) }, client, testActor, { fetchImpl });

    expect(result).toEqual({
      total_matched: 0,
      pushed: 0,
      errors: 0,
      failed_people: [],
      failed: [],
      succeededPersonIds: [],
      failedPersonIds: [],
      nextOffset: 0,
      done: true,
    });
  });
});

const CAMPAIGN_ID = "42";

/** okFetch() plus the attach-leads endpoint, recording each attach call's
 * lead ids and `parallel` flag for assertions. */
function okFetchWithCampaign(attachCalls: Array<{ leadIds: string[]; parallel: unknown }>): typeof fetch {
  const base = okFetch();
  return vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith(`/api/campaigns/${CAMPAIGN_ID}/leads/attach-leads`)) {
      const body = JSON.parse((init?.body as string) ?? "{}");
      attachCalls.push({ leadIds: body.lead_ids, parallel: body.parallel });
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    }
    return (base as unknown as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init);
  }) as unknown as typeof fetch;
}

describe("runPeopleAddToCampaign", () => {
  it("auto-runs Add to EmailBison first when no prior platform_pushes row exists", async () => {
    const niche = unique("campaign-auto");
    await seedPeople(niche, [{ slug: "a" }, { slug: "b" }]);
    const client = await insertClient();
    const attachCalls: Array<{ leadIds: string[]; parallel: unknown }> = [];

    const result = await runPeopleAddToCampaign(
      { niche: includeOnly([niche]) },
      client,
      CAMPAIGN_ID,
      testActor,
      { fetchImpl: okFetchWithCampaign(attachCalls) }
    );

    expect(result.total_matched).toBe(2);
    expect(result.attached).toBe(2);
    expect(result.errors).toBe(0);
    expect(attachCalls).toHaveLength(2);
    for (const call of attachCalls) {
      expect(call.leadIds).toHaveLength(1);
    }

    const { data: people } = await supabaseAdmin
      .from("people")
      .select("id")
      .like("linkedin_url", `%${niche}%`);
    const personIds = (people ?? []).map((p) => p.id as string);
    const { data: pushRows } = await supabaseAdmin
      .from("platform_pushes")
      .select("platform_contact_id,campaign_tag,pushed_at,pushed_by_user_id,pushed_by_email")
      .in("person_id", personIds);
    expect(pushRows).toHaveLength(2);
    for (const row of pushRows!) {
      expect(row.platform_contact_id).toBeTruthy();
      expect(row.campaign_tag).toBe(CAMPAIGN_ID);
      expect(row.pushed_at).toBeTruthy();
      expect(row.pushed_by_user_id).toBe(testActor.id);
      expect(row.pushed_by_email).toBe(testActor.email);
    }
  });

  it("skips the Add to EmailBison step when a platform_contact_id already exists", async () => {
    const niche = unique("campaign-skip");
    await seedPeople(niche, [{ slug: "a" }]);
    const client = await insertClient();

    const upsertResult = await runPeopleAddToEmailBison({ niche: includeOnly([niche]) }, client, otherActor, {
      fetchImpl: okFetch(),
    });
    expect(upsertResult.pushed).toBe(1);

    const { data: person } = await supabaseAdmin
      .from("people")
      .select("id")
      .eq("linkedin_url", testLinkedin(`${niche}-a`))
      .single();
    const { data: beforeRow } = await supabaseAdmin
      .from("platform_pushes")
      .select("platform_contact_id")
      .eq("person_id", person!.id as string)
      .single();

    const upsertFetchSpy = vi.fn().mockImplementation(async () => {
      throw new Error("Add-to-EmailBison endpoint should not be called when a lead id already exists");
    });
    const attachCalls: Array<{ leadIds: string[]; parallel: unknown }> = [];
    const fetchImpl = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith(`/api/campaigns/${CAMPAIGN_ID}/leads/attach-leads`)) {
        const body = JSON.parse((init?.body as string) ?? "{}");
        attachCalls.push({ leadIds: body.lead_ids, parallel: body.parallel });
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      return upsertFetchSpy();
    }) as unknown as typeof fetch;

    const result = await runPeopleAddToCampaign({ niche: includeOnly([niche]) }, client, CAMPAIGN_ID, testActor, {
      fetchImpl,
    });

    expect(result.attached).toBe(1);
    expect(result.errors).toBe(0);
    expect(upsertFetchSpy).not.toHaveBeenCalled();
    expect(attachCalls).toEqual([{ leadIds: [beforeRow!.platform_contact_id], parallel: undefined }]);

    const { data: afterRow } = await supabaseAdmin
      .from("platform_pushes")
      .select("pushed_by_user_id,pushed_by_email")
      .eq("person_id", person!.id as string)
      .single();
    expect(afterRow!.pushed_by_user_id).toBe(testActor.id);
    expect(afterRow!.pushed_by_email).toBe(testActor.email);
  });

  it("respects the parallel vs. sequential attach setting", async () => {
    const niche = unique("campaign-parallel");
    await seedPeople(niche, [{ slug: "a" }]);
    const client = await insertClient();
    const attachCalls: Array<{ leadIds: string[]; parallel: unknown }> = [];

    await runPeopleAddToCampaign({ niche: includeOnly([niche]) }, client, CAMPAIGN_ID, testActor, {
      fetchImpl: okFetchWithCampaign(attachCalls),
      parallel: true,
    });

    expect(attachCalls).toEqual([{ leadIds: expect.any(Array), parallel: true }]);
  });

  it("does not abort on a failed campaign attach call, and does not touch platform_pushes", async () => {
    const niche = unique("campaign-attach-fail");
    await seedPeople(niche, [{ slug: "a" }]);
    const client = await insertClient();
    const fetchImpl = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith(`/api/campaigns/${CAMPAIGN_ID}/leads/attach-leads`)) {
        return { ok: false, status: 500, json: async () => ({ message: "down" }) } as unknown as Response;
      }
      return (okFetch() as unknown as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    const result = await runPeopleAddToCampaign({ niche: includeOnly([niche]) }, client, CAMPAIGN_ID, testActor, {
      fetchImpl,
    });

    expect(result.total_matched).toBe(1);
    expect(result.attached).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toBeTruthy();

    const { data: person } = await supabaseAdmin
      .from("people")
      .select("id")
      .eq("linkedin_url", testLinkedin(`${niche}-a`))
      .single();
    const { data: pushRow } = await supabaseAdmin
      .from("platform_pushes")
      .select("platform_contact_id,campaign_tag")
      .eq("person_id", person!.id as string)
      .single();
    expect(pushRow!.platform_contact_id).toBeTruthy();
    expect(pushRow!.campaign_tag).toBeNull();
  });

  it("reports a per-lead attach failure without failing (or un-attaching) the leads that did attach (issue #106)", async () => {
    const niche = unique("campaign-partial-attach");
    await seedPeople(niche, [{ slug: "a" }, { slug: "b" }]);
    const client = await insertClient();
    const base = okFetch();
    let attachCallCount = 0;
    const fetchImpl = vi.fn().mockImplementation(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith(`/api/campaigns/${CAMPAIGN_ID}/leads/attach-leads`)) {
        attachCallCount++;
        if (attachCallCount === 1) {
          return {
            ok: false,
            status: 422,
            json: async () => ({
              data: { success: false, message: "No leads were added because they are in another sequence" },
            }),
          } as unknown as Response;
        }
        return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
      }
      return (base as unknown as (u: unknown, i?: RequestInit) => Promise<Response>)(url, init);
    }) as unknown as typeof fetch;

    const result = await runPeopleAddToCampaign({ niche: includeOnly([niche]) }, client, CAMPAIGN_ID, testActor, {
      fetchImpl,
    });

    expect(result.total_matched).toBe(2);
    expect(result.attached).toBe(1);
    expect(result.errors).toBe(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].reason).toContain("another sequence");

    const { data: people } = await supabaseAdmin
      .from("people")
      .select("id")
      .like("linkedin_url", `%${niche}%`);
    const personIds = (people ?? []).map((p) => p.id as string);
    const { data: pushRows } = await supabaseAdmin
      .from("platform_pushes")
      .select("platform_contact_id,campaign_tag")
      .in("person_id", personIds);
    expect(pushRows).toHaveLength(2);
    for (const row of pushRows!) {
      expect(row.platform_contact_id).toBeTruthy();
    }
    expect(pushRows!.filter((r) => r.campaign_tag === CAMPAIGN_ID)).toHaveLength(1);
    expect(pushRows!.filter((r) => r.campaign_tag === null)).toHaveLength(1);
  });

  it("returns an all-zero result for an empty filter match", async () => {
    const niche = unique("campaign-empty");
    const client = await insertClient();
    const attachCalls: Array<{ leadIds: string[]; parallel: unknown }> = [];

    const result = await runPeopleAddToCampaign({ niche: includeOnly([niche]) }, client, CAMPAIGN_ID, testActor, {
      fetchImpl: okFetchWithCampaign(attachCalls),
    });

    expect(result).toEqual({
      total_matched: 0,
      attached: 0,
      errors: 0,
      failed_people: [],
      failed: [],
      succeededPersonIds: [],
      failedPersonIds: [],
      nextOffset: 0,
      done: true,
    });
    expect(attachCalls).toEqual([]);
  });
});

describe("runCompaniesAddToCampaign", () => {
  it("resolves matching Companies to every linked Person and attaches them", async () => {
    const niche = unique("campaign-companies");
    const companyId = await insertCompany(niche, "campaign-with-people");
    await seedPeople(niche, [
      { slug: "linked-a", companyId },
      { slug: "linked-b", companyId },
    ]);
    const client = await insertClient();
    const attachCalls: Array<{ leadIds: string[]; parallel: unknown }> = [];

    const result = await runCompaniesAddToCampaign({ niche: includeOnly([niche]) }, client, CAMPAIGN_ID, testActor, {
      fetchImpl: okFetchWithCampaign(attachCalls),
    });

    expect(result.total_matched).toBe(2);
    expect(result.attached).toBe(2);
    expect(result.errors).toBe(0);
  });
});
