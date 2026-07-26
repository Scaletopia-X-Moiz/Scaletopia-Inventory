/**
 * One-off before/after benchmark for the pages that only had ESTIMATES:
 * People list, Company detail, Person detail. Mirrors scripts/bench-dashboard.ts
 * (builds its own client to avoid the "server-only" marker; times real queries
 * against the live DB). No browser involved.
 *
 *   npx tsx scripts/bench-pages.ts
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
}
const db = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

const PEOPLE_LIST_COLUMNS =
  "id,company_id,full_name,job_title,email,phone,linkedin_url,domain,city,state,country,source,tags,last_updated,email_status,email_verified_at,phone_type,phone_status,phone_verified_at,company_name,company_linkedin_url";
const PAGE_SIZE = 1000;

// ---- helpers -------------------------------------------------------------
async function median(label: string, runs: number, fn: () => Promise<unknown>): Promise<number> {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    await fn();
    times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  const med = times[Math.floor(times.length / 2)];
  console.log(`  ${label}: median ${med.toFixed(0)}ms  (runs: ${times.map((t) => t.toFixed(0)).join(", ")})`);
  return med;
}

async function fetchAllPeople(): Promise<unknown[]> {
  const { count } = await db.from("people").select("id", { count: "exact", head: true });
  const total = count ?? 0;
  const pageCount = Math.ceil(total / PAGE_SIZE);
  const pages = await Promise.all(
    Array.from({ length: pageCount }, (_, i) =>
      db.from("people").select(PEOPLE_LIST_COLUMNS).order("id", { ascending: true })
        .range(i * PAGE_SIZE, i * PAGE_SIZE + PAGE_SIZE - 1)
    )
  );
  const rows: unknown[] = [];
  for (const p of pages) rows.push(...((p.data ?? []) as unknown[]));
  return rows;
}

// ---- benchmarks ----------------------------------------------------------
async function main() {
  // sample ids for the detail benches
  const { data: companySample } = await db.from("people")
    .select("id,company_id").not("company_id", "is", null).limit(1).maybeSingle();
  const personId = companySample?.id as string;
  const companyId = companySample?.company_id as string;

  console.log("\n=== PEOPLE LIST (page 1, 50 rows) ===");
  await median("BEFORE  full-table scan + JS paginate", 3, async () => {
    const rows = await fetchAllPeople();
    rows.slice(0, 50); // JS pagination
  });
  await median("AFTER   DB-side count+order+range     ", 3, async () => {
    await db.from("people").select(PEOPLE_LIST_COLUMNS, { count: "exact" })
      .order("last_updated", { ascending: false, nullsFirst: false })
      .order("id", { ascending: true })
      .range(0, 49);
  });

  console.log("\n=== COMPANY DETAIL ===");
  await median("BEFORE  two sequential queries        ", 5, async () => {
    const c = await db.from("companies").select("*").eq("id", companyId).maybeSingle();
    void c;
    await db.from("people").select("id,full_name,job_title,email,phone")
      .eq("company_id", companyId).order("full_name", { ascending: true }).limit(500);
  });
  await median("AFTER   Promise.all (parallel)        ", 5, async () => {
    await Promise.all([
      db.from("companies").select("*").eq("id", companyId).maybeSingle(),
      db.from("people").select("id,full_name,job_title,email,phone")
        .eq("company_id", companyId).order("full_name", { ascending: true }).limit(500),
    ]);
  });

  console.log("\n=== PERSON DETAIL ===");
  await median("BEFORE  person then company (2 seq)   ", 5, async () => {
    const p = await db.from("people").select("*").eq("id", personId).maybeSingle();
    const cid = (p.data as { company_id?: string } | null)?.company_id;
    if (cid) await db.from("companies").select("id,company_name,domain,quality_tier").eq("id", cid).maybeSingle();
  });
  await median("AFTER   single embedded query         ", 5, async () => {
    await db.from("people").select("*, companies(id,company_name,domain,quality_tier)")
      .eq("id", personId).maybeSingle();
  });

  console.log();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
