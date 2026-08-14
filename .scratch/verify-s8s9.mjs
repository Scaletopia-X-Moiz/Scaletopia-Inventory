import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

// 1) New jobs since 23:00 UTC
const { data: jobs, error } = await admin
  .from("push_jobs")
  .select("id,platform,entity,action,campaign_id,status,total,processed,succeeded,created,updated,failed,failures,filters,options,error,created_at,finished_at")
  .gte("created_at", "2026-08-14T23:01:00Z")
  .order("created_at", { ascending: true });
if (error) throw error;
console.log(`NEW jobs since 23:01 UTC: ${jobs.length}`);
for (const j of jobs) {
  console.log("=".repeat(80));
  console.log(`[${j.id}] ${j.created_at} -> ${j.finished_at}`);
  console.log(`  platform=${j.platform} entity=${j.entity} action=${j.action} status=${j.status}`);
  console.log(`  total=${j.total} processed=${j.processed} succ=${j.succeeded} cr=${j.created} up=${j.updated} failed=${j.failed}`);
  console.log(`  error: ${JSON.stringify(j.error)}`);
  console.log(`  options.sourceEntityTotal=${j.options?.sourceEntityTotal}  full options=${JSON.stringify(j.options)}`);
  console.log(`  filters=${JSON.stringify(j.filters)}`);
  const f = j.failures ?? [];
  console.log(`  failures stored=${f.length}` + (f.length ? ` sample=${JSON.stringify(f.slice(0,2))}` : ""));
}
