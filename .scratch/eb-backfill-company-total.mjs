import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const DRY_RUN = process.argv[2] !== "--apply";

// Mirror of EMPLOYEE_BUCKETS (lib/data/employee-size.ts)
const EMPLOYEE_BUCKETS = [
  { id: "1-10", min: 1, max: 10 }, { id: "11-50", min: 11, max: 50 },
  { id: "51-200", min: 51, max: 200 }, { id: "201-500", min: 201, max: 500 },
  { id: "500+", min: 501, max: null },
];
const employeeBucketRanges = (ids = []) =>
  EMPLOYEE_BUCKETS.filter((b) => ids.includes(b.id)).map((b) => ({ min_v: b.min, max_v: b.max }));

// Mirror of toFilterOptionsRpcPayload (lib/data/companies.ts)
function toRpcPayload(f) {
  const hasExplicitRange = f.employeeMin != null || f.employeeMax != null;
  return {
    search: f.search ?? null,
    employeeMin: f.employeeMin ?? null,
    employeeMax: f.employeeMax ?? null,
    employeeBucketRanges: hasExplicitRange ? [] : employeeBucketRanges(f.employeeBucket ?? []),
    email: f.email ?? "any",
    phone: f.phone ?? "any",
    niche: f.niche ?? { include: [], exclude: [] },
    source: f.source ?? { include: [], exclude: [] },
    industry: f.industry ?? { include: [], exclude: [] },
    country: f.country ?? { include: [], exclude: [] },
    emailStatus: f.emailStatus ?? { include: [], exclude: [] },
    phoneType: f.phoneType ?? { include: [], exclude: [] },
    virtualFilters: f.virtualFilters ?? { combinator: "and", groups: [] },
    pushStatus: f.pushStatus ? { clientId: f.pushStatus.clientId, platform: f.pushStatus.platform, status: f.pushStatus.status } : null,
  };
}

// Old company jobs missing the count. (pushJobId-restricted jobs use a different
// resolver than the RPC, so skip those — the RPC count wouldn't match.)
const { data: jobs, error } = await admin
  .from("push_jobs")
  .select("id, platform, entity, action, status, total, options, filters, created_at")
  .eq("entity", "companies")
  .order("created_at", { ascending: false });
if (error) throw error;

const targets = jobs.filter(
  (j) => (j.options?.sourceEntityTotal == null) && !j.filters?.pushJobId
);
const skipped = jobs.filter((j) => j.options?.sourceEntityTotal != null || j.filters?.pushJobId);
console.log(`${jobs.length} company jobs total | ${targets.length} to backfill | ${skipped.length} skipped (already set or pushJobId-restricted)`);
console.log(DRY_RUN ? "\n*** DRY RUN — pass --apply to write ***\n" : "\n*** APPLYING ***\n");

for (const j of targets) {
  const payload = toRpcPayload(j.filters ?? {});
  const r = await admin.rpc("companies_matching_virtual_filters", { filters: payload }, { count: "exact", head: true });
  if (r.error) { console.log(`  ${j.id}  RPC ERROR: ${r.error.message}`); continue; }
  const companyCount = r.count ?? 0;
  console.log(`  ${j.created_at.slice(0,10)} ${j.id.slice(0,8)}  people(total)=${j.total}  → companies=${companyCount}`);
  if (!DRY_RUN) {
    const newOptions = { ...(j.options ?? {}), sourceEntityTotal: companyCount };
    const u = await admin.from("push_jobs").update({ options: newOptions }).eq("id", j.id);
    if (u.error) console.log(`     UPDATE ERROR: ${u.error.message}`);
  }
}
console.log("\ndone.");
