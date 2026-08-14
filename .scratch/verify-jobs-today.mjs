import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await admin
  .from("push_jobs")
  .select("id, client_id, platform, entity, action, campaign_id, status, total, processed, succeeded, created, updated, failed, failures, filters, options, error, created_at, finished_at, triggered_by_email")
  .in("platform", ["emailbison_companies", "emailbison_people", "emailbison_campaign"])
  .gte("created_at", "2026-08-15T00:00:00Z")
  .order("created_at", { ascending: true });
if (error) throw error;

console.log(`Found ${data.length} EmailBison push_jobs created today\n`);
for (const j of data) {
  console.log("=".repeat(80));
  console.log(`id=${j.id}`);
  console.log(`  ${j.created_at} -> ${j.finished_at}`);
  console.log(`  platform=${j.platform} entity=${j.entity} action=${j.action} campaign_id=${j.campaign_id} status=${j.status}`);
  console.log(`  total=${j.total} processed=${j.processed} succ=${j.succeeded} created=${j.created} updated=${j.updated} failed=${j.failed}`);
  console.log(`  client_id=${j.client_id} by=${j.triggered_by_email}`);
  if (j.error) console.log(`  error: ${j.error}`);
  console.log(`  options: ${JSON.stringify(j.options)}`);
  console.log(`  filters: ${JSON.stringify(j.filters)}`);
  const f = j.failures ?? [];
  console.log(`  failures: count=${f.length}`);
  if (f.length) console.log(`    sample failures: ${JSON.stringify(f.slice(0, 3))}`);
}

// distinct clients
const clientIds = [...new Set(data.map((j) => j.client_id))];
console.log("\nClient ids used today:", clientIds);
for (const cid of clientIds) {
  const { data: c } = await admin.from("clients").select("id,name,emailbison_workspace_id").eq("id", cid).single();
  console.log(`  ${cid} -> ${c?.name} base=${c?.emailbison_workspace_id}`);
}
