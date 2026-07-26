/**
 * One-time backfill: populates country_id / source_tokens / industry_id /
 * employee_count / company_linkedin_url / niche_tokens on every existing
 * people row, using the same normalize*()/nichesFromTags() functions the
 * import pipeline now writes on every insert/update (see
 * docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md and
 * lib/data/people-canonical-columns.sql, which must be run first to add the
 * columns).
 *
 * Run once via `npm run backfill:canonical-columns-people`. Safe to re-run —
 * it's idempotent (recomputes from the current raw country/source/tags
 * columns and the row's linked company every time) and skips rows whose
 * canonical columns already match.
 *
 * Deliberately does not import lib/supabase/admin.ts: that module pulls in
 * the "server-only" marker package, which throws unconditionally outside a
 * Next.js server bundle. This script builds its own client instead.
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";
import { normalizeCountry } from "@/lib/data/country";
import { normalizeSourceTokens } from "@/lib/data/source";
import { nichesFromTags } from "@/lib/data/niche";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}
const supabaseAdmin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

interface Row {
  id: string;
  company_id: string | null;
  country: string | null;
  source: string | null;
  tags: string[] | null;
  country_id: string | null;
  source_tokens: string[] | null;
  industry_id: string | null;
  employee_count: number | null;
  company_linkedin_url: string | null;
  niche_tokens: string[] | null;
}

interface CompanyRow {
  id: string;
  client: string | null;
  niche: string | null;
  industry_id: string | null;
  employee_count: number | null;
  linkedin_url: string | null;
}

const PAGE_SIZE = 1000;
const UPDATE_BATCH_SIZE = 500;
const UPDATE_CONCURRENCY = 8;

function sameTokens(a: string[] | null, b: string[]): boolean {
  if (!a) return b.length === 0;
  if (a.length !== b.length) return false;
  const as = [...a].sort();
  const bs = [...b].sort();
  return as.every((v, i) => v === bs[i]);
}

async function fetchPage(from: number): Promise<Row[]> {
  const { data, error } = await supabaseAdmin
    .from("people")
    .select(
      "id,company_id,country,source,tags,country_id,source_tokens,industry_id,employee_count,company_linkedin_url,niche_tokens"
    )
    .order("id", { ascending: true })
    .range(from, from + PAGE_SIZE - 1);
  if (error) throw error;
  return (data ?? []) as unknown as Row[];
}

/** Companies is ~87k rows — small enough to hold entirely in memory once for
 * the whole backfill run rather than re-fetching per page of people. */
async function fetchAllCompanies(): Promise<{
  byId: Map<string, CompanyRow>;
  knownClients: Set<string>;
}> {
  const byId = new Map<string, CompanyRow>();
  const knownClients = new Set<string>();

  const { count, error: countError } = await supabaseAdmin
    .from("companies")
    .select("id", { count: "exact", head: true });
  if (countError) throw countError;
  const total = count ?? 0;

  for (let from = 0; from < total; from += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin
      .from("companies")
      .select("id,client,niche,industry_id,employee_count,linkedin_url")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    for (const row of (data ?? []) as unknown as CompanyRow[]) {
      byId.set(row.id, row);
      if (row.client) knownClients.add(row.client.trim().toLowerCase());
    }
  }

  return { byId, knownClients };
}

async function main() {
  console.log("Loading companies for people canonical-column derivation...");
  const { byId: companyById, knownClients } = await fetchAllCompanies();
  console.log(`Loaded ${companyById.size} companies.`);

  const { count, error: countError } = await supabaseAdmin
    .from("people")
    .select("id", { count: "exact", head: true });
  if (countError) throw countError;

  const total = count ?? 0;
  console.log(`Backfilling canonical columns for ${total} people rows...`);

  let scanned = 0;
  let changed = 0;
  const pendingUpdates: {
    id: string;
    country_id: string | null;
    source_tokens: string[];
    industry_id: string | null;
    employee_count: number | null;
    company_linkedin_url: string | null;
    niche_tokens: string[];
  }[] = [];

  const flush = async () => {
    if (pendingUpdates.length === 0) return;
    const batches: (typeof pendingUpdates)[] = [];
    for (let i = 0; i < pendingUpdates.length; i += UPDATE_BATCH_SIZE) {
      batches.push(pendingUpdates.slice(i, i + UPDATE_BATCH_SIZE));
    }
    for (let i = 0; i < batches.length; i += UPDATE_CONCURRENCY) {
      const window = batches.slice(i, i + UPDATE_CONCURRENCY);
      const results = await Promise.all(
        window.map((batch) =>
          supabaseAdmin.rpc("backfill_canonical_columns_people", { updates: batch })
        )
      );
      for (const { error } of results) {
        if (error) throw error;
      }
    }
    pendingUpdates.length = 0;
  };

  for (let from = 0; from < total; from += PAGE_SIZE) {
    const rows = await fetchPage(from);
    for (const row of rows) {
      scanned++;

      const company = row.company_id ? companyById.get(row.company_id) : undefined;

      const countryId = normalizeCountry(row.country)?.id ?? null;
      const sourceTokens = normalizeSourceTokens(row.source);
      const industryId = company?.industry_id ?? null;
      const employeeCount = company?.employee_count ?? null;
      const companyLinkedinUrl = company?.linkedin_url ?? null;
      const nicheTokens = company?.niche
        ? [company.niche]
        : nichesFromTags(row.tags, knownClients);

      const upToDate =
        row.country_id === countryId &&
        sameTokens(row.source_tokens, sourceTokens) &&
        row.industry_id === industryId &&
        row.employee_count === employeeCount &&
        row.company_linkedin_url === companyLinkedinUrl &&
        sameTokens(row.niche_tokens, nicheTokens);
      if (upToDate) continue;

      changed++;
      pendingUpdates.push({
        id: row.id,
        country_id: countryId,
        source_tokens: sourceTokens,
        industry_id: industryId,
        employee_count: employeeCount,
        company_linkedin_url: companyLinkedinUrl,
        niche_tokens: nicheTokens,
      });
    }
    if (pendingUpdates.length >= UPDATE_BATCH_SIZE * UPDATE_CONCURRENCY) await flush();
    console.log(`  scanned ${scanned}/${total}, ${changed} rows changed so far`);
  }
  await flush();

  console.log(`Done. Scanned ${scanned} rows, updated ${changed}.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
