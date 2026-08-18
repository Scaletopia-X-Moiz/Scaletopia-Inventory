import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { runPeopleGhlPush, splitGhlEligibility } from "@/lib/ghl/push-to-ghl";
import { includeOnly } from "@/lib/data/include-exclude";
import { resolveDefaultFieldMapping } from "@/lib/push/resolve-default-field-mapping";
import type { ClientRow } from "@/lib/data/clients";
import type { GhlPushCandidate } from "@/lib/data/people";

const TEST_PREFIX = "__test-ghl-push__";

function testLinkedin(slug: string): string {
  return `https://linkedin.com/in/${TEST_PREFIX}${slug}`;
}

/** platform_pushes has plain (non-cascading) FKs to both people and clients,
 * so its rows for this test's people/clients must be deleted before either of
 * them — otherwise the people/client deletes below fail FK validation and
 * silently leave rows behind (supabase-js doesn't throw on a delete error
 * here) for the next run to collide with. */
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
}

let testActor: { id: string; email: string };

beforeAll(async () => {
  await cleanupAll();
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email: `${TEST_PREFIX}actor-${Date.now()}@example.com`,
    email_confirm: true,
  });
  if (error || !data.user) throw error ?? new Error("failed to create test actor");
  testActor = { id: data.user.id, email: data.user.email! };
});
afterAll(async () => {
  await cleanupAll();
  if (testActor) await supabaseAdmin.auth.admin.deleteUser(testActor.id);
});

let counter = 0;
function unique(label: string): string {
  counter++;
  return `${TEST_PREFIX}${label}-${counter}`;
}

interface SeedPerson {
  slug: string;
  phoneType: "mobile" | "toll_free" | "landline" | null;
  fullName?: string;
  customData?: Record<string, unknown>;
}

async function seedPeople(niche: string, rows: SeedPerson[]) {
  const { error } = await supabaseAdmin.from("people").insert(
    rows.map((r) => ({
      linkedin_url: testLinkedin(`${niche}-${r.slug}`),
      full_name: r.fullName ?? `Ghl Test ${r.slug}`,
      first_name: r.fullName ?? `Ghl Test ${r.slug}`,
      last_name: r.slug,
      email: `${TEST_PREFIX}${niche}-${r.slug}@example.com`,
      phone: "+15555550100",
      phone_type: r.phoneType,
      niche_tokens: [niche],
      city: "Austin",
      country: "US",
      source: "clay",
      company_name: "Acme Co",
      employee_count: 25,
      custom_data: r.customData ?? null,
    }))
  );
  if (error) throw error;
}

async function insertClient(overrides: Record<string, unknown> = {}): Promise<ClientRow> {
  const slug = unique("client");
  const { data, error } = await supabaseAdmin
    .from("clients")
    .insert({
      slug,
      name: slug,
      ghl_api_key: "test-api-key",
      ghl_location_id: "loc_test",
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

let contactCounter = 0;
function okFetch(): typeof fetch {
  return vi.fn().mockImplementation(async () => {
    contactCounter++;
    return {
      ok: true,
      status: 201,
      json: async () => ({ contact: { id: `contact_${contactCounter}` } }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function candidate(phoneType: string | null): GhlPushCandidate {
  return {
    id: `id-${phoneType ?? "null"}-${Math.random()}`,
    displayName: "Test Person",
    phoneType,
    record: {
      firstName: "Test",
      lastName: "Person",
      email: null,
      phone: null,
      companyName: null,
      brandName: null,
      city: null,
      country: null,
      niche: null,
      employeeCount: null,
      source: null,
      title: null,
      website: null,
      state: null,
      fullName: null,
      linkedinUrl: null,
      linkedinUsername: null,
      phoneType: null,
      phoneStatus: null,
      emailStatus: null,
      sourceId: null,
      tags: null,
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      lastUpdated: null,
      createdAt: null,
      companyCity: null,
      companyState: null,
      companyCountry: null,
      companyIndustry: null,
      companyWebsiteUrl: null,
      companyLinkedinUrl: null,
      companyDomain: null,
      companyPhone: null,
      companyPhoneType: null,
      companyPhoneStatus: null,
      companyEmail: null,
      companyEmailStatus: null,
      companyEmailVerifiedAt: null,
      companyPhoneVerifiedAt: null,
      companyQualityTier: null,
      companyClient: null,
      companyDescription: null,
      companyFoundedYear: null,
      companyRevenue: null,
      companyDomainStatus: null,
      companyMxProvider: null,
      companySecurityGateway: null,
      companyKeywords: null,
      companyTechnologies: null,
      companyTags: null,
      companyCreatedAt: null,
      companyLastUpdated: null,
    },
    customData: null,
  };
}

describe("splitGhlEligibility", () => {
  it("counts mobile and toll_free as eligible", () => {
    const result = splitGhlEligibility([candidate("mobile"), candidate("toll_free")]);
    expect(result.total_matched).toBe(2);
    expect(result.eligible).toHaveLength(2);
    expect(result.skipped).toBe(0);
  });

  it("counts landline, other, and null phone types as skipped", () => {
    const result = splitGhlEligibility([candidate("landline"), candidate("other"), candidate(null)]);
    expect(result.total_matched).toBe(3);
    expect(result.eligible).toHaveLength(0);
    expect(result.skipped).toBe(3);
  });

  it("splits a mixed batch correctly", () => {
    const result = splitGhlEligibility([
      candidate("mobile"),
      candidate("landline"),
      candidate("toll_free"),
      candidate(null),
    ]);
    expect(result.total_matched).toBe(4);
    expect(result.eligible.map((c) => c.phoneType)).toEqual(["mobile", "toll_free"]);
    expect(result.skipped).toBe(2);
  });

  it("returns all-zero for an empty input", () => {
    const result = splitGhlEligibility([]);
    expect(result).toEqual({ total_matched: 0, eligible: [], skipped: 0 });
  });
});

describe("runPeopleGhlPush", () => {
  it("pushes eligible mobile/toll-free people and skips landlines", async () => {
    const niche = unique("mixed");
    await seedPeople(niche, [
      { slug: "mobile", phoneType: "mobile" },
      { slug: "toll-free", phoneType: "toll_free" },
      { slug: "landline", phoneType: "landline" },
    ]);
    const client = await insertClient();
    const fetchImpl = okFetch();

    const result = await runPeopleGhlPush(
      { niche: includeOnly([niche]) },
      client,
      testActor,
      { fetchImpl }
    );

    expect(result.total_matched).toBe(3);
    expect(result.eligible).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.pushed).toBe(2);
    // Fresh people with no prior platform_pushes row → both classified created.
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.errors).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("logs each successful push to platform_pushes and updates the person", async () => {
    const niche = unique("log");
    await seedPeople(niche, [{ slug: "a", phoneType: "mobile" }]);
    const client = await insertClient();
    const fetchImpl = okFetch();

    await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, { fetchImpl });

    const { data: person } = await supabaseAdmin
      .from("people")
      .select("id,pushed_to_ghl,pushed_to_ghl_at")
      .eq("linkedin_url", testLinkedin(`${niche}-a`))
      .single();
    expect(person?.pushed_to_ghl).toBe(true);
    expect(person?.pushed_to_ghl_at).toBeTruthy();

    const { data: pushRows } = await supabaseAdmin
      .from("platform_pushes")
      .select("platform,platform_contact_id,campaign_tag,client_id,person_id,pushed_by_user_id,pushed_by_email")
      .eq("person_id", person!.id as string);
    expect(pushRows).toHaveLength(1);
    expect(pushRows![0].platform).toBe("ghl");
    expect(pushRows![0].client_id).toBe(client.id);
    expect(pushRows![0].campaign_tag).toBeNull();
    expect(pushRows![0].platform_contact_id).toBeTruthy();
    expect(pushRows![0].pushed_by_user_id).toBe(testActor.id);
    expect(pushRows![0].pushed_by_email).toBe(testActor.email);
  });

  it("sends only the user-typed tag — no structured client/niche/source tag", async () => {
    const niche = unique("tag-user");
    await seedPeople(niche, [{ slug: "a", phoneType: "mobile" }]);
    const client = await insertClient();
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse((init?.body as string) ?? "{}"));
      contactCounter++;
      return {
        ok: true,
        status: 201,
        json: async () => ({ contact: { id: `contact_${contactCounter}` } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl,
      customTagSuffix: "leadership",
    });

    // Tags travel over the separate append-only tags call (bodies[1]), not
    // the upsert body (bodies[0]) — see the CRITICAL comment on
    // pushContactToGhl (lib/ghl/client.ts) for why.
    expect(bodies[0].tags).toBeUndefined();
    expect(bodies[1]).toEqual({ tags: ["leadership"] });

    const { data: person } = await supabaseAdmin
      .from("people")
      .select("id")
      .eq("linkedin_url", testLinkedin(`${niche}-a`))
      .single();
    const { data: pushRows } = await supabaseAdmin
      .from("platform_pushes")
      .select("campaign_tag")
      .eq("person_id", person!.id as string);
    expect(pushRows![0].campaign_tag).toBe("leadership");
  });

  it("sends no tags and a null campaign_tag when the tag field is left blank", async () => {
    const niche = unique("tag-blank");
    await seedPeople(niche, [{ slug: "a", phoneType: "mobile" }]);
    const client = await insertClient();
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse((init?.body as string) ?? "{}"));
      contactCounter++;
      return {
        ok: true,
        status: 201,
        json: async () => ({ contact: { id: `contact_${contactCounter}` } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, { fetchImpl });

    // Empty tags never make it into the upsert body at all (destructured out
    // in pushContactToGhl), and an empty-tags payload skips the append call
    // entirely — only the upsert call happens.
    expect(bodies[0].tags).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const { data: person } = await supabaseAdmin
      .from("people")
      .select("id")
      .eq("linkedin_url", testLinkedin(`${niche}-a`))
      .single();
    const { data: pushRows } = await supabaseAdmin
      .from("platform_pushes")
      .select("campaign_tag")
      .eq("person_id", person!.id as string);
    expect(pushRows![0].campaign_tag).toBeNull();
  });

  it("re-pushes on a second run and overwrites the platform_pushes row (no dedupe)", async () => {
    const niche = unique("repeat");
    await seedPeople(niche, [{ slug: "a", phoneType: "mobile" }]);
    const client = await insertClient();

    const first = await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl: okFetch(),
    });
    expect(first.pushed).toBe(1);

    const secondFetch = okFetch();
    const second = await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl: secondFetch,
    });

    expect(second.total_matched).toBe(1);
    expect(second.pushed).toBe(1);
    expect(secondFetch).toHaveBeenCalledTimes(1);

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

  it("does not abort the batch on a per-record failure", async () => {
    const niche = unique("partial-fail");
    await seedPeople(niche, [
      { slug: "ok1", phoneType: "mobile" },
      { slug: "bad", phoneType: "mobile", fullName: "Bad Contact" },
      { slug: "ok2", phoneType: "toll_free" },
    ]);
    const client = await insertClient();

    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.firstName === "Bad Contact") {
        return {
          ok: false,
          status: 401,
          json: async () => ({ message: "invalid api key" }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 201,
        json: async () => ({ contact: { id: "contact_ok" } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, { fetchImpl });

    expect(result.total_matched).toBe(3);
    expect(result.eligible).toBe(3);
    expect(result.pushed).toBe(2);
    expect(result.created).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.errors).toBe(1);
    expect(result.failed_people).toContain("Bad Contact");
    // Per-record failure reason is threaded through (feedback item 2c).
    expect(result.failed).toContainEqual({ name: "Bad Contact", reason: expect.stringContaining("invalid api key") });
  });

  it("returns an all-zero result for an empty filter match", async () => {
    const niche = unique("empty");
    const client = await insertClient();
    const fetchImpl = okFetch();

    const result = await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, { fetchImpl });

    expect(result).toEqual({
      total_matched: 0,
      eligible: 0,
      skipped: 0,
      pushed: 0,
      created: 0,
      updated: 0,
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

  it("throws when the client has no GHL credentials configured", async () => {
    const niche = unique("no-creds");
    const client = await insertClient({ ghl_api_key: null, ghl_location_id: null });

    await expect(
      runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor)
    ).rejects.toThrow("GHL credentials");
  });

  it("classifies a record with a prior platform_pushes row as updated, a first-time one as created", async () => {
    // Created vs updated uses the DB-side platform_pushes pre-existence
    // heuristic (uniform across every push surface, feedback item 2b), not
    // GHL's own new-vs-deduped signal: a record with a prior (person, client,
    // "ghl") row before this run is "updated", the rest "created".
    const niche = unique("created-updated");
    await seedPeople(niche, [
      { slug: "new", phoneType: "mobile" },
      { slug: "existing", phoneType: "mobile" },
    ]);
    const client = await insertClient();

    // Seed a prior push for the "existing" person so the heuristic sees a
    // pre-existing row and classifies it as updated.
    const { data: existingPerson } = await supabaseAdmin
      .from("people")
      .select("id")
      .eq("linkedin_url", testLinkedin(`${niche}-existing`))
      .single();
    const { error: seedError } = await supabaseAdmin.from("platform_pushes").insert({
      person_id: existingPerson!.id as string,
      client_id: client.id,
      platform: "ghl",
      platform_contact_id: "prior_contact",
      pushed_at: new Date().toISOString(),
      pushed_by_user_id: testActor.id,
      pushed_by_email: testActor.email,
    });
    if (seedError) throw seedError;

    const result = await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, { fetchImpl: okFetch() });

    expect(result.pushed).toBe(2);
    expect(result.created).toBe(1);
    expect(result.updated).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("includes mapped virtual-column values as customFields on the push payload", async () => {
    const niche = unique("field-mapping");
    await seedPeople(niche, [
      { slug: "a", phoneType: "mobile", customData: { lead_score: 87, plan: "pro" } },
      { slug: "b", phoneType: "mobile", customData: { lead_score: null } },
    ]);
    const client = await insertClient();
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse((init?.body as string) ?? "{}"));
      contactCounter++;
      return {
        ok: true,
        status: 201,
        json: async () => ({ contact: { id: `contact_${contactCounter}` } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl,
      fieldMapping: [{ ghlFieldId: "f1", source: "column", columnKey: "lead_score" }],
    });

    const customFields = bodies.map((b) => b.customFields);
    expect(customFields).toContainEqual([{ id: "f1", value: "87" }]);
    // The second person's lead_score is null, so its customFields is omitted
    // entirely from the wire payload rather than sent as an empty array.
    expect(customFields.some((c) => c === undefined)).toBe(true);
  });

  it("sends no customFields at all when no field mapping is supplied", async () => {
    const niche = unique("no-mapping");
    await seedPeople(niche, [{ slug: "a", phoneType: "mobile", customData: { lead_score: 87 } }]);
    const client = await insertClient();
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse((init?.body as string) ?? "{}"));
      contactCounter++;
      return {
        ok: true,
        status: 201,
        json: async () => ({ contact: { id: `contact_${contactCounter}` } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, { fetchImpl });

    expect(bodies[0].customFields).toBeUndefined();
  });

  it("omits a field from the sent payload when standardFieldMapping marks it skip", async () => {
    const niche = unique("std-skip");
    await seedPeople(niche, [{ slug: "a", phoneType: "mobile" }]);
    const client = await insertClient();
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse((init?.body as string) ?? "{}"));
      contactCounter++;
      return {
        ok: true,
        status: 201,
        json: async () => ({ contact: { id: `contact_${contactCounter}` } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl,
      standardFieldMapping: {
        companyName: "brand_name",
        firstName: "include",
        lastName: "include",
        email: "include",
        phone: "include",
        city: "skip",
        country: "include",
      },
    });

    expect(bodies[0].city).toBeUndefined();
  });

  it("sends the raw company_name (not brand_name) when standardFieldMapping picks company_name", async () => {
    const niche = unique("std-company-name");
    await seedPeople(niche, [{ slug: "a", phoneType: "mobile" }]);
    const client = await insertClient();
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse((init?.body as string) ?? "{}"));
      contactCounter++;
      return {
        ok: true,
        status: 201,
        json: async () => ({ contact: { id: `contact_${contactCounter}` } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl,
      standardFieldMapping: {
        companyName: "company_name",
        firstName: "include",
        lastName: "include",
        email: "include",
        phone: "include",
        city: "include",
        country: "include",
      },
    });

    // Seeded people have no linked company (no brand_name), so company_name
    // ("Acme Co") is the only candidate — this confirms the mapping routes
    // through the raw field rather than silently falling back either way.
    expect(bodies[0].companyName).toBe("Acme Co");
  });

  it("falls back to the auto-mapping default from resolveDefaultFieldMapping when no explicit mapping is chosen for a field", async () => {
    const niche = unique("std-default");
    await seedPeople(niche, [{ slug: "a", phoneType: "mobile" }]);
    const client = await insertClient();
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse((init?.body as string) ?? "{}"));
      contactCounter++;
      return {
        ok: true,
        status: 201,
        json: async () => ({ contact: { id: `contact_${contactCounter}` } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    // No brand_name anywhere in this pushed set, so #108's (free-source)
    // default resolves companyName to the raw "companyName" column — verify
    // that default, threaded straight through to runPeopleGhlPush, produces
    // the raw name on the wire.
    const defaults = resolveDefaultFieldMapping({
      platform: "ghl",
      records: [{ companyName: "Acme Co", brandName: null }],
      virtualColumns: [],
      customFields: [],
    });
    expect(defaults.standardFields.companyName).toBe("companyName");

    await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl,
      standardFieldMapping: defaults.standardFields,
    });

    expect(bodies[0].companyName).toBe("Acme Co");
  });

  it("reproduces today's behavior exactly when standardFieldMapping is omitted", async () => {
    const niche = unique("std-omitted");
    await seedPeople(niche, [{ slug: "a", phoneType: "mobile" }]);
    const client = await insertClient();
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse((init?.body as string) ?? "{}"));
      contactCounter++;
      return {
        ok: true,
        status: 201,
        json: async () => ({ contact: { id: `contact_${contactCounter}` } }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, { fetchImpl });

    expect(bodies[0].companyName).toBe("Acme Co");
    expect(bodies[0].city).toBe("Austin");
    expect(bodies[0].country).toBe("US");
  });

  it("reports progress through resolving, pushing, and done phases", async () => {
    const niche = unique("progress");
    await seedPeople(niche, [
      { slug: "a", phoneType: "mobile" },
      { slug: "b", phoneType: "mobile" },
    ]);
    const client = await insertClient();
    const fetchImpl = okFetch();
    const progress: Array<{ phase: string; done: number; total: number }> = [];

    await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, testActor, {
      fetchImpl,
      onProgress: (p) => progress.push({ phase: p.phase, done: p.done, total: p.total }),
    });

    expect(progress[0]).toEqual({ phase: "resolving", done: 0, total: 0 });
    expect(progress[1]).toEqual({ phase: "pushing", done: 0, total: 2 });
    const last = progress[progress.length - 1];
    expect(last).toEqual({ phase: "done", done: 2, total: 2 });
  });
});
