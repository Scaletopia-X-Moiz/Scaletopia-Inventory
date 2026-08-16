import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TESTING_ID = "0c556239-1608-41fc-9fda-89196c55a56f";
const { data, error } = await admin.from("push_jobs").select("*").eq("client_id", TESTING_ID).order("created_at", { ascending: false }).limit(40);
if (error) { console.error(error); process.exit(1); }
for (const j of data) {
  console.log(`\n[${j.id}] ${j.created_at} entity=${j.entity} action=${j.action} status=${j.status} total=${j.total} processed=${j.processed} succeeded=${j.succeeded} failed=${j.failed} by=${j.triggered_by_email}`);
  console.log(`  filters=${JSON.stringify(j.filters)}`);
  console.log(`  options=${JSON.stringify(j.options)}`);
  if (j.failed) console.log(`  failures(sample)=${JSON.stringify((j.failures||[]).slice(0,3))} totalFailures=${(j.failures||[]).length}`);
  console.log(`  started=${j.started_at} finished=${j.finished_at}`);
}
