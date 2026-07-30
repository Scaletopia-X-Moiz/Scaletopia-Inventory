import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { runPeopleGhlPush } from "@/lib/ghl/push-to-ghl";
import { includeOnly } from "@/lib/data/include-exclude";
import type { ClientRow } from "@/lib/data/clients";

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

beforeAll(cleanupAll);
afterAll(cleanupAll);

let counter = 0;
function unique(label: string): string {
  counter++;
  return `${TEST_PREFIX}${label}-${counter}`;
}

interface SeedPerson {
  slug: string;
  phoneType: "mobile" | "toll_free" | "landline" | null;
  fullName?: string;
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
      { fetchImpl }
    );

    expect(result.total_matched).toBe(3);
    expect(result.eligible).toBe(2);
    expect(result.skipped).toBe(1);
    expect(result.pushed).toBe(2);
    expect(result.errors).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("logs each successful push to platform_pushes and updates the person", async () => {
    const niche = unique("log");
    await seedPeople(niche, [{ slug: "a", phoneType: "mobile" }]);
    const client = await insertClient();
    const fetchImpl = okFetch();

    await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, { fetchImpl });

    const { data: person } = await supabaseAdmin
      .from("people")
      .select("id,pushed_to_ghl,pushed_to_ghl_at")
      .eq("linkedin_url", testLinkedin(`${niche}-a`))
      .single();
    expect(person?.pushed_to_ghl).toBe(true);
    expect(person?.pushed_to_ghl_at).toBeTruthy();

    const { data: pushRows } = await supabaseAdmin
      .from("platform_pushes")
      .select("platform,platform_contact_id,campaign_tag,client_id,person_id")
      .eq("person_id", person!.id as string);
    expect(pushRows).toHaveLength(1);
    expect(pushRows![0].platform).toBe("ghl");
    expect(pushRows![0].client_id).toBe(client.id);
    expect(pushRows![0].campaign_tag).toContain(client.name);
    expect(pushRows![0].platform_contact_id).toBeTruthy();
  });

  it("re-pushes on a second run and overwrites the platform_pushes row (no dedupe)", async () => {
    const niche = unique("repeat");
    await seedPeople(niche, [{ slug: "a", phoneType: "mobile" }]);
    const client = await insertClient();

    const first = await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, {
      fetchImpl: okFetch(),
    });
    expect(first.pushed).toBe(1);

    const secondFetch = okFetch();
    const second = await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, {
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

    const result = await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, { fetchImpl });

    expect(result.total_matched).toBe(3);
    expect(result.eligible).toBe(3);
    expect(result.pushed).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.failed_people).toContain("Bad Contact");
  });

  it("returns an all-zero result for an empty filter match", async () => {
    const niche = unique("empty");
    const client = await insertClient();
    const fetchImpl = okFetch();

    const result = await runPeopleGhlPush({ niche: includeOnly([niche]) }, client, { fetchImpl });

    expect(result).toEqual({
      total_matched: 0,
      eligible: 0,
      skipped: 0,
      pushed: 0,
      errors: 0,
      failed_people: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws when the client has no GHL credentials configured", async () => {
    const niche = unique("no-creds");
    const client = await insertClient({ ghl_api_key: null, ghl_location_id: null });

    await expect(
      runPeopleGhlPush({ niche: includeOnly([niche]) }, client)
    ).rejects.toThrow("GHL credentials");
  });
});
