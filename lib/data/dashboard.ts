import { supabaseAdmin } from "@/lib/supabase/admin";
import { fetchAllRows } from "@/lib/data/fetch-all-rows";
import { withTtlCache } from "@/lib/data/cache-with-ttl";
import { normalizeSourceTokens, sourceLabel } from "@/lib/data/source";
import { normalizeCountry } from "@/lib/data/country";

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

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

function sortedBreakdown(
  counts: Map<string, { label: string; count: number }>
): BreakdownEntry[] {
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

async function getDashboardUncached(range: DashboardDateRange = {}): Promise<Dashboard> {
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
    if (row.industry?.trim()) {
      const id = row.industry.trim().toLowerCase();
      bump(industries, id, titleCase(id));
    }
    const country = normalizeCountry(row.country);
    if (country) bump(countries, country.id, country.label);
  }

  const recentCompanies: RecentCompany[] = (recentCompaniesRes.data ?? []).map((c) => ({
    id: String(c.id),
    name: c.company_name ?? "Unknown",
    niche: c.niche,
    country: normalizeCountry(c.country)?.label ?? c.country,
    createdAt: c.created_at,
  }));

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

/** Full-table aggregation is expensive (~29k rows scanned per call), so dedupe
 * and cache by date-range for 60s — matching the TTL used by the companies and
 * people queries. Concurrent requests share one in-flight scan. */
export const getDashboard = withTtlCache(getDashboardUncached, 60_000);
