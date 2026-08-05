import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  getCompanies,
  getAllFilteredCompanies,
  getCompanyFilterOptions,
  type CompanyListFilters,
} from "@/lib/data/companies";
import type { PushStatusFilter } from "@/lib/data/push-status-filter";

// C1 (#130): the Companies data layer honors `filters.pushStatus` with the
// "has work left" semantics locked in the epic (#125) — a company matches
// `not_pushed` if >=1 linked person is not yet pushed to that client/platform,
// and `pushed` if it has people and every one is already pushed. The predicate
// lives in F2's SQL (companies_matching_virtual_filters / company_filter_options);
// this suite drives it through the TS read paths (list, export, facets) to prove
// the trigger in resolveVirtualFilterIds fires and every consumer inherits it.
//
// Every query is bounded by a per-test `search` marker (matched against the
// distinctive company_name below). `search` is applied by both the resolver RPC
// and the facet base CTE, so it scopes the scan to this test's handful of rows
// instead of the whole ~110k-row companies table — keeping "not yet pushed for a
// brand-new client" (which otherwise matches nearly every company) fast and its
// result set small enough to assert exactly.
const TEST_PREFIX = "__test-push-status-company__";
const PLATFORM = "ghl" as const;

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
  // platform_pushes (FK child of both people and clients) before either parent.
  if (clientIds.length > 0) {
    await supabaseAdmin.from("platform_pushes").delete().in("client_id", clientIds);
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
    .insert({ slug, name: `Push Status Co ${slug}` })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

/** Companies carry `marker` in their company_name so a `search: marker` filter
 * scopes every query to just this test's rows. */
async function insertCompany(
  slug: string,
  marker: string,
  overrides: Record<string, unknown> = {}
): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("companies")
    .insert({ domain: testDomain(slug), company_name: `${marker} ${slug}`, ...overrides })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function insertPerson(slug: string, companyId: string): Promise<string> {
  const { data, error } = await supabaseAdmin
    .from("people")
    .insert({
      linkedin_url: testLinkedin(slug),
      full_name: `Person ${slug}`,
      source: "clay",
      company_id: companyId,
    })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function recordPush(personId: string, clientId: string): Promise<void> {
  const { error } = await supabaseAdmin
    .from("platform_pushes")
    .insert({ person_id: personId, client_id: clientId, platform: PLATFORM });
  if (error) throw error;
}

function pushFilter(
  clientId: string,
  status: PushStatusFilter["status"],
  marker: string
): CompanyListFilters {
  return { search: marker, pushStatus: { clientId, platform: PLATFORM, status } };
}

describe("Companies pushStatus filter", () => {
  it("flips a company from not_pushed to pushed as its people are pushed", async () => {
    const marker = unique("flip");
    const clientId = await insertClient();
    const companyId = await insertCompany("flip", marker);
    const alice = await insertPerson("flip-alice", companyId);
    const bob = await insertPerson("flip-bob", companyId);

    const idsFor = async (status: PushStatusFilter["status"]) =>
      new Set((await getCompanies(pushFilter(clientId, status, marker), 1, 200)).rows.map((r) => r.id));

    // Nothing pushed yet: has work left -> not_pushed matches, pushed does not.
    expect(await idsFor("not_pushed")).toEqual(new Set([companyId]));
    expect(await idsFor("pushed")).toEqual(new Set());

    // Push one of two people: still >=1 pending, so it stays under not_pushed
    // and remains absent from pushed.
    await recordPush(alice, clientId);
    expect(await idsFor("not_pushed")).toEqual(new Set([companyId]));
    expect(await idsFor("pushed")).toEqual(new Set());

    // Push the second: every linked person is now pushed, so it flips —
    // out of not_pushed, into pushed.
    await recordPush(bob, clientId);
    expect(await idsFor("not_pushed")).toEqual(new Set());
    expect(await idsFor("pushed")).toEqual(new Set([companyId]));
  });

  it("returns only push-matching companies and is client-aware", async () => {
    const marker = unique("scope");
    const clientA = await insertClient();
    const clientB = await insertClient();

    // fullyPushed: single person, pushed to client A.
    const fullyPushed = await insertCompany("fully", marker);
    const fullyPerson = await insertPerson("fully-p", fullyPushed);
    await recordPush(fullyPerson, clientA);

    // partiallyPushed: two people, only one pushed to client A -> has work left.
    const partiallyPushed = await insertCompany("partial", marker);
    const partA = await insertPerson("partial-a", partiallyPushed);
    await insertPerson("partial-b", partiallyPushed);
    await recordPush(partA, clientA);

    // untouched: one person, never pushed anywhere.
    const untouched = await insertCompany("untouched", marker);
    await insertPerson("untouched-p", untouched);

    const idsFor = async (clientId: string, status: PushStatusFilter["status"]) =>
      new Set((await getCompanies(pushFilter(clientId, status, marker), 1, 500)).rows.map((r) => r.id));

    // Client A: not_pushed = partial (1 pending) + untouched; pushed = fully only.
    expect(await idsFor(clientA, "not_pushed")).toEqual(new Set([partiallyPushed, untouched]));
    expect(await idsFor(clientA, "pushed")).toEqual(new Set([fullyPushed]));

    // Client-aware: nothing was pushed to client B, so every one of these
    // companies (each with >=1 person) is "not yet pushed" for B, and none is
    // "already pushed".
    expect(await idsFor(clientB, "not_pushed")).toEqual(
      new Set([fullyPushed, partiallyPushed, untouched])
    );
    expect(await idsFor(clientB, "pushed")).toEqual(new Set());
  });

  it("a company with no people never matches either status", async () => {
    const marker = unique("empty");
    const clientId = await insertClient();
    await insertCompany("empty", marker); // no people linked

    const notPushed = new Set(
      (await getCompanies(pushFilter(clientId, "not_pushed", marker), 1, 500)).rows.map((r) => r.id)
    );
    const pushed = new Set(
      (await getCompanies(pushFilter(clientId, "pushed", marker), 1, 500)).rows.map((r) => r.id)
    );
    expect(notPushed).toEqual(new Set());
    expect(pushed).toEqual(new Set());
  });

  it("export (getAllFilteredCompanies) inherits the same narrowing", async () => {
    const marker = unique("export");
    const clientId = await insertClient();
    const pushedCo = await insertCompany("export-pushed", marker);
    const pushedPerson = await insertPerson("export-pushed-p", pushedCo);
    await recordPush(pushedPerson, clientId);

    const pendingCo = await insertCompany("export-pending", marker);
    await insertPerson("export-pending-p", pendingCo);

    const exportedNotPushed = new Set(
      (await getAllFilteredCompanies(pushFilter(clientId, "not_pushed", marker))).map((r) => r.id)
    );
    expect(exportedNotPushed).toEqual(new Set([pendingCo]));

    const exportedPushed = new Set(
      (await getAllFilteredCompanies(pushFilter(clientId, "pushed", marker))).map((r) => r.id)
    );
    expect(exportedPushed).toEqual(new Set([pushedCo]));
  });

  it("facets reflect the push-narrowed set", async () => {
    const marker = unique("facet");
    const clientId = await insertClient();
    const niche = unique("niche");

    // Two companies sharing a distinctive niche: one fully pushed, one pending.
    const pendingCo = await insertCompany("facet-pending", marker, { niche });
    await insertPerson("facet-pending-p", pendingCo);

    const pushedCo = await insertCompany("facet-pushed", marker, { niche });
    const pushedPerson = await insertPerson("facet-pushed-p", pushedCo);
    await recordPush(pushedPerson, clientId);

    const nicheCount = (options: { niches: { id: string; count: number }[] }) =>
      options.niches.find((n) => n.id === niche)?.count ?? 0;

    // The niche facet excludes its own filter but is scoped by search + pushStatus,
    // so for this niche it counts exactly the companies matching that status:
    // not_pushed -> only pendingCo (1); pushed -> only pushedCo (1).
    expect(nicheCount(await getCompanyFilterOptions(pushFilter(clientId, "not_pushed", marker)))).toBe(1);
    expect(nicheCount(await getCompanyFilterOptions(pushFilter(clientId, "pushed", marker)))).toBe(1);
  });
});
