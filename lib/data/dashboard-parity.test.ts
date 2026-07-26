import { describe, expect, it } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/data/fetch-all-rows";
import { normalizeSourceTokens, sourceLabel } from "@/lib/data/source";
import { countryLabel, normalizeCountry } from "@/lib/data/country";
import { normalizeIndustry } from "@/lib/data/industry";
import { getDashboard, type Dashboard, type DashboardDateRange } from "@/lib/data/dashboard";

// Frozen copy of getDashboard's pre-issue-27 JS-scan implementation
// (paginates the full companies table via fetchAllRows and aggregates in
// application code), kept only here to prove the new dashboard_stats
// RPC-backed getDashboard (lib/data/dashboard.ts) returns identical values.
// Delete this file once the RPC has run in production long enough that this
// guarantee is no longer load-bearing.
//
// One deliberate deviation: the legacy dashboard grouped industries by a raw
// `trim().toLowerCase()` of the `industry` column, which never merged the
// ";"-delimited vs ","-delimited variants of the same industry (e.g.
// "technology; information and internet" vs "technology, information and
// internet" showed as two separate slices — a pre-existing bug). The RPC
// groups on the canonical `industry_id` column instead (normalizeIndustry's
// canonicalKey, ADR 0001), which already merges these — the same column
// every other industry breakdown in the app (company_filter_options) uses.
// So this legacy copy uses normalizeIndustry() too, to assert parity against
// the *correct* grouping rather than bit-for-bit replicate the bug.
//
// Same reasoning for countries: the legacy dashboard labeled each country
// bucket from whichever row's raw casing it saw first via
// normalizeCountry(...).label, so an all-caps code like "UY" title-cased to
// "UY" (slice(1) preserves original casing) while lowercase "uy" would have
// produced "Uy" — non-deterministic across rows with the same id. countryLabel(id)
// (country.ts) is the deterministic label already used by company_filter_options,
// so it's used here for the same reason as industryLabel.

function sortedBreakdown(
  counts: Map<string, { label: string; count: number }>
): Dashboard["niches"] {
  return Array.from(counts.entries())
    .map(([id, v]) => ({ id, label: v.label, count: v.count }))
    .sort((a, b) => b.count - a.count);
}

function bump(map: Map<string, { label: string; count: number }>, id: string, label: string) {
  const existing = map.get(id);
  if (existing) existing.count += 1;
  else map.set(id, { label, count: 1 });
}

interface CompanyScanRow {
  niche: string | null;
  source: string | null;
  industry: string | null;
  country: string | null;
}

async function getDashboardLegacy(range: DashboardDateRange = {}): Promise<Dashboard> {
  const [companiesCount, peopleCount, rows, recentCompaniesRes] = await Promise.all([
    (() => {
      let q = supabaseAdmin.from("companies").select("id", { count: "exact", head: true });
      if (range.from) q = q.gte("created_at", range.from);
      if (range.to) q = q.lt("created_at", range.to);
      return q;
    })(),
    (() => {
      let q = supabaseAdmin.from("people").select("id", { count: "exact", head: true });
      if (range.from) q = q.gte("created_at", range.from);
      if (range.to) q = q.lt("created_at", range.to);
      return q;
    })(),
    fetchAllRows<CompanyScanRow>("companies", "niche,source,industry,country", (query) => {
      let q = query;
      if (range.from) q = q.gte("created_at", range.from);
      if (range.to) q = q.lt("created_at", range.to);
      return q;
    }),
    (() => {
      let q = supabaseAdmin
        .from("companies")
        .select("id,company_name,niche,country,created_at")
        .order("created_at", { ascending: false })
        .limit(5);
      if (range.from) q = q.gte("created_at", range.from);
      if (range.to) q = q.lt("created_at", range.to);
      return q;
    })(),
  ]);

  if (companiesCount.error) throw companiesCount.error;
  if (peopleCount.error) throw peopleCount.error;
  if (recentCompaniesRes.error) throw recentCompaniesRes.error;

  const niches = new Map<string, { label: string; count: number }>();
  const sources = new Map<string, { label: string; count: number }>();
  const industries = new Map<string, { label: string; count: number }>();
  const countries = new Map<string, { label: string; count: number }>();

  for (const row of rows) {
    if (row.niche) bump(niches, row.niche, row.niche);
    for (const token of normalizeSourceTokens(row.source)) {
      bump(sources, token, sourceLabel(token));
    }
    const industry = normalizeIndustry(row.industry);
    if (industry) bump(industries, industry.id, industry.label);
    const country = normalizeCountry(row.country);
    if (country) bump(countries, country.id, countryLabel(country.id));
  }

  const recentCompanies: Dashboard["recentCompanies"] = (recentCompaniesRes.data ?? []).map(
    (c) => ({
      id: String(c.id),
      name: c.company_name ?? "Unknown",
      niche: c.niche,
      country: normalizeCountry(c.country)?.label ?? c.country,
      createdAt: c.created_at,
    })
  );

  return {
    totalCompanies: companiesCount.count ?? 0,
    totalPeople: peopleCount.count ?? 0,
    niches: sortedBreakdown(niches),
    sources: sortedBreakdown(sources),
    industries: sortedBreakdown(industries),
    countries: sortedBreakdown(countries),
    recentCompanies,
  };
}

function byId<T extends { id: string }>(entries: T[]): T[] {
  return [...entries].sort((a, b) => a.id.localeCompare(b.id));
}

function expectBreakdownsEqual(actual: Dashboard, expected: Dashboard) {
  expect(actual.totalCompanies).toBe(expected.totalCompanies);
  expect(actual.totalPeople).toBe(expected.totalPeople);
  expect(byId(actual.niches)).toEqual(byId(expected.niches));
  expect(byId(actual.sources)).toEqual(byId(expected.sources));
  expect(byId(actual.industries)).toEqual(byId(expected.industries));
  expect(byId(actual.countries)).toEqual(byId(expected.countries));
  expect(actual.recentCompanies).toEqual(expected.recentCompanies);
}

describe("getDashboard RPC parity with legacy JS-scan implementation", () => {
  it("matches for the no-range (all-time) case", async () => {
    const [rpcResult, legacyResult] = await Promise.all([getDashboard(), getDashboardLegacy()]);
    expectBreakdownsEqual(rpcResult, legacyResult);
  }, 180000);

  it("matches for a representative date range", async () => {
    const legacyAllTime = await getDashboardLegacy();
    const sample = legacyAllTime.recentCompanies[legacyAllTime.recentCompanies.length - 1];
    if (!sample?.createdAt) return;

    const range: DashboardDateRange = { from: sample.createdAt };
    const [rpcResult, legacyResult] = await Promise.all([
      getDashboard(range),
      getDashboardLegacy(range),
    ]);
    expectBreakdownsEqual(rpcResult, legacyResult);
  }, 180000);
});
