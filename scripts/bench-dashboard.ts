/**
 * Manual, repeatable before/after benchmark for the Overview dashboard
 * (issue #27 / docs/prds/app-wide-navigation-and-dashboard-latency.md).
 * Not part of the automated test suite — run by hand against the live DB:
 *
 *   npm run bench:dashboard
 *
 * "Before" replays the pre-issue-27 fetchAllRows + JS-aggregation approach
 * directly; "after" calls the current dashboard_stats RPC. Reports
 * wall-clock elapsed ms and a rough response byte size for each.
 *
 * Deliberately does not import lib/supabase/admin.ts or lib/data/dashboard.ts:
 * both pull in the "server-only" marker package (via lib/data/fetch-all-rows.ts
 * -> lib/supabase/admin.ts), which throws unconditionally outside a Next.js
 * server bundle. This script builds its own client instead, matching
 * lib/import/backfill-canonical-columns.ts.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { normalizeSourceTokens, sourceLabel } from "@/lib/data/source";
import { normalizeCountry } from "@/lib/data/country";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}
const supabaseAdmin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

const PAGE_SIZE = 1000;

async function fetchAllRows<T>(table: string, columns: string): Promise<T[]> {
  const { count, error: countError } = await supabaseAdmin
    .from(table)
    .select(columns, { count: "exact", head: true });
  if (countError) throw countError;

  const total = count ?? 0;
  if (total === 0) return [];

  const pageCount = Math.ceil(total / PAGE_SIZE);
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, i) =>
      supabaseAdmin
        .from(table)
        .select(columns)
        .order("id", { ascending: true })
        .range(i * PAGE_SIZE, i * PAGE_SIZE + PAGE_SIZE - 1)
    )
  );

  const rows: T[] = [];
  for (const page of pages) {
    if (page.error) throw page.error;
    rows.push(...((page.data ?? []) as T[]));
  }
  return rows;
}

interface CompanyScanRow {
  niche: string | null;
  source: string | null;
  industry: string | null;
  country: string | null;
}

async function before() {
  const [companiesCount, peopleCount, rows, recentCompaniesRes] = await Promise.all([
    supabaseAdmin.from("companies").select("id", { count: "exact", head: true }),
    supabaseAdmin.from("people").select("id", { count: "exact", head: true }),
    fetchAllRows<CompanyScanRow>("companies", "niche,source,industry,country"),
    supabaseAdmin
      .from("companies")
      .select("id,company_name,niche,country,created_at")
      .order("created_at", { ascending: false })
      .limit(5),
  ]);

  const niches = new Map<string, number>();
  const sources = new Map<string, number>();
  const industries = new Map<string, number>();
  const countries = new Map<string, number>();
  for (const row of rows) {
    if (row.niche) niches.set(row.niche, (niches.get(row.niche) ?? 0) + 1);
    for (const token of normalizeSourceTokens(row.source)) {
      sources.set(token, (sources.get(token) ?? 0) + 1);
    }
    if (row.industry?.trim()) {
      const id = row.industry.trim().toLowerCase();
      industries.set(id, (industries.get(id) ?? 0) + 1);
    }
    const country = normalizeCountry(row.country);
    if (country) countries.set(country.id, (countries.get(country.id) ?? 0) + 1);
  }

  return {
    totalCompanies: companiesCount.count ?? 0,
    totalPeople: peopleCount.count ?? 0,
    niches: Array.from(niches.entries()),
    sources: Array.from(sources.entries()).map(([id, count]) => ({ id, label: sourceLabel(id), count })),
    industries: Array.from(industries.entries()),
    countries: Array.from(countries.entries()),
    recentCompanies: recentCompaniesRes.data ?? [],
  };
}

async function after() {
  const { data, error } = await supabaseAdmin.rpc("dashboard_stats", {
    range_from: null,
    range_to: null,
  });
  if (error) throw error;
  return data;
}

async function timed<T>(label: string, fn: () => Promise<T>): Promise<void> {
  const start = performance.now();
  const result = await fn();
  const elapsedMs = performance.now() - start;
  const bytes = Buffer.byteLength(JSON.stringify(result));
  console.log(`${label}: ${elapsedMs.toFixed(0)}ms, ${(bytes / 1024).toFixed(1)}KB`);
}

async function main() {
  console.log("Dashboard benchmark — before (JS scan) vs after (dashboard_stats RPC)\n");
  await timed("before (fetchAllRows + JS aggregation)", before);
  await timed("after  (dashboard_stats RPC)          ", after);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
