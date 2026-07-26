import { supabaseAdmin } from "@/lib/supabase/admin";
import { withTtlCache } from "@/lib/data/cache-with-ttl";
import { sourceLabel } from "@/lib/data/source";
import { industryLabel } from "@/lib/data/industry";
import { countryLabel, normalizeCountry } from "@/lib/data/country";

export interface BreakdownEntry {
  id: string;
  label: string;
  count: number;
}

export interface RecentCompany {
  id: string;
  name: string;
  niche: string | null;
  country: string | null;
  createdAt: string | null;
}

export interface Dashboard {
  totalCompanies: number;
  totalPeople: number;
  niches: BreakdownEntry[];
  sources: BreakdownEntry[];
  industries: BreakdownEntry[];
  countries: BreakdownEntry[];
  recentCompanies: RecentCompany[];
}

/** Bounds are ISO instants; `to` is treated as exclusive so callers can pass
 * the start of the day *after* the last day they want included. */
export interface DashboardDateRange {
  from?: string;
  to?: string;
}

function sortByCountDesc(a: { count: number }, b: { count: number }): number {
  return b.count - a.count;
}

interface FacetIdCount {
  id: string;
  count: number;
}

interface DashboardStatsRpcResult {
  totalCompanies: number;
  totalPeople: number;
  niches: FacetIdCount[];
  sources: FacetIdCount[];
  industries: FacetIdCount[];
  countries: FacetIdCount[];
  recentCompanies: {
    id: string;
    name: string | null;
    niche: string | null;
    country: string | null;
    createdAt: string | null;
  }[];
}

/** Aggregation runs in Postgres via the dashboard_stats RPC
 * (lib/data/dashboard-stats.sql), grouping on the canonical columns from ADR
 * 0001 (country_id, industry_id, source_tokens) plus `niche`, instead of
 * paging the whole ~109k-row companies table into the app and counting in
 * JS. Only ids/counts come back from SQL; labels are attached here from the
 * same TypeScript alias tables (sourceLabel/industryLabel/countryLabel) the
 * /companies facets use, so casing/display stays single-edit-point and
 * identical to before. `recentCompanies` carries the raw `country` text (not
 * country_id) so it can keep going through normalizeCountry() exactly as the
 * old JS-scan implementation did. */
async function getDashboardUncached(range: DashboardDateRange = {}): Promise<Dashboard> {
  const { data, error } = await supabaseAdmin.rpc("dashboard_stats", {
    range_from: range.from ?? null,
    range_to: range.to ?? null,
  });
  if (error) throw error;
  const result = data as DashboardStatsRpcResult;

  const recentCompanies: RecentCompany[] = result.recentCompanies.map((c) => ({
    id: String(c.id),
    name: c.name ?? "Unknown",
    niche: c.niche,
    country: normalizeCountry(c.country)?.label ?? c.country,
    createdAt: c.createdAt,
  }));

  return {
    totalCompanies: result.totalCompanies,
    totalPeople: result.totalPeople,
    niches: result.niches.map(({ id, count }) => ({ id, label: id, count })).sort(sortByCountDesc),
    sources: result.sources
      .map(({ id, count }) => ({ id, label: sourceLabel(id), count }))
      .sort(sortByCountDesc),
    industries: result.industries
      .map(({ id, count }) => ({ id, label: industryLabel(id), count }))
      .sort(sortByCountDesc),
    countries: result.countries
      .map(({ id, count }) => ({ id, label: countryLabel(id), count }))
      .sort(sortByCountDesc),
    recentCompanies,
  };
}

/** Cached by date-range for 60s under a stable key — matching the TTL used by
 * the companies and people queries — so the cache survives dev-mode recompiles
 * and repeat views inside the TTL are instant. Concurrent requests share one
 * in-flight call. */
export const getDashboard = withTtlCache(getDashboardUncached, 60_000, "dashboard");
