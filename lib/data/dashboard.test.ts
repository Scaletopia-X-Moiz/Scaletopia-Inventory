import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getDashboard } from "@/lib/data/dashboard";
import { supabaseAdmin } from "@/lib/supabase/admin";

// platform_pushes can be genuinely empty in some environments (issue #71 —
// nothing has been pushed yet), unlike companies/people which always have
// real rows. Seed one fixture row so totalPushes has something to count,
// mirroring lib/data/push-history.test.ts's insert-then-cleanup pattern.
// Seeded before any getDashboard() call so the 60s TTL cache never gets
// populated with a stale pre-fixture totalPushes value.
const TEST_PREFIX = "__test-dashboard-pushes__";

async function cleanup() {
  const { data: people } = await supabaseAdmin
    .from("people")
    .select("id")
    .like("linkedin_url", `%${TEST_PREFIX}%`);
  const personIds = (people ?? []).map((p) => (p as { id: string }).id);
  if (personIds.length > 0) {
    await supabaseAdmin.from("platform_pushes").delete().in("person_id", personIds);
  }
  await supabaseAdmin.from("people").delete().like("linkedin_url", `%${TEST_PREFIX}%`);
  await supabaseAdmin.from("clients").delete().like("slug", `${TEST_PREFIX}%`);
}

beforeAll(async () => {
  await cleanup();
  const { data: person, error: personError } = await supabaseAdmin
    .from("people")
    .insert({ linkedin_url: `https://linkedin.com/in/${TEST_PREFIX}`, full_name: "Dashboard Test Person" })
    .select("id")
    .single();
  if (personError) throw personError;

  const { data: client, error: clientError } = await supabaseAdmin
    .from("clients")
    .insert({ slug: TEST_PREFIX, name: "Dashboard Test Client" })
    .select("id")
    .single();
  if (clientError) throw clientError;

  const { error: pushError } = await supabaseAdmin.from("platform_pushes").insert({
    person_id: (person as { id: string }).id,
    client_id: (client as { id: string }).id,
    platform: "ghl",
    pushed_at: new Date().toISOString(),
  });
  if (pushError) throw pushError;
});

afterAll(cleanup);

describe("getDashboard", () => {
  it("returns all-time totals and breakdowns with no range", async () => {
    const dashboard = await getDashboard();

    expect(dashboard.totalCompanies).toBeGreaterThan(0);
    expect(dashboard.totalPeople).toBeGreaterThan(0);
    expect(dashboard.totalPushes).toBeGreaterThan(0);
    expect(dashboard.niches.length).toBeGreaterThan(0);
    expect(dashboard.recentCompanies.length).toBeGreaterThan(0);
  }, 30000);

  it("totalPushes is an all-time count, unaffected by the date-range picker", async () => {
    const allTime = await getDashboard();
    const futureYear = new Date().getFullYear() + 1;
    const future = await getDashboard({ from: `${futureYear}-01-01T00:00:00.000Z` });

    expect(future.totalPushes).toBe(allTime.totalPushes);
  }, 30000);

  it("a future `from` bound empties breakdowns, recent companies, and totals", async () => {
    const futureYear = new Date().getFullYear() + 1;
    const future = await getDashboard({ from: `${futureYear}-01-01T00:00:00.000Z` });

    expect(future.recentCompanies).toHaveLength(0);
    expect(future.niches).toHaveLength(0);
    expect(future.sources).toHaveLength(0);

    // totals are scoped to the range, so a future-only window has nothing in it.
    expect(future.totalCompanies).toBe(0);
    expect(future.totalPeople).toBe(0);
  }, 30000);

  it("narrowing the range never returns higher totals than all-time", async () => {
    const allTime = await getDashboard();
    const sample = allTime.recentCompanies[0];
    if (!sample?.createdAt) return;

    const narrowed = await getDashboard({ from: sample.createdAt });
    expect(narrowed.totalCompanies).toBeLessThanOrEqual(allTime.totalCompanies);
    expect(narrowed.totalPeople).toBeLessThanOrEqual(allTime.totalPeople);
  }, 30000);

  it("narrowing the range never returns more recent companies than all-time", async () => {
    const allTime = await getDashboard();
    const sample = allTime.recentCompanies[0];
    if (!sample?.createdAt) return;

    const narrowed = await getDashboard({ from: sample.createdAt });
    for (const company of narrowed.recentCompanies) {
      expect(new Date(company.createdAt ?? 0).getTime()).toBeGreaterThanOrEqual(
        new Date(sample.createdAt).getTime()
      );
    }
  }, 30000);
});
