import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await admin
  .from("push_jobs")
  .select("id, client_id, platform, entity, action, campaign_id, status, total, processed, succeeded, created, updated, failed, failures, filters, options, error, created_at, finished_at, niche")
  .in("platform", ["emailbison_companies", "emailbison_people", "emailbison_campaign"])
  .gte("created_at", "2026-08-14T22:30:00Z")
  .order("created_at", { ascending: true });
if (error) throw error;

console.log(`Found ${data.length} jobs in run window\n`);
let n = 0;
for (const j of data) {
  n++;
  console.log("=".repeat(90));
  console.log(`[JOB ${n}] id=${j.id}  ${j.created_at}`);
  console.log(`  platform=${j.platform} entity=${j.entity} action=${j.action} campaign_id=${j.campaign_id} status=${j.status}`);
  console.log(`  total=${j.total} processed=${j.processed} succ=${j.succeeded} created=${j.created} updated=${j.updated} failed=${j.failed}`);
  if (j.error) console.log(`  error: ${j.error}`);
  console.log(`  niche: ${JSON.stringify(j.niche)}`);
  console.log(`  options: ${JSON.stringify(j.options, null, 1)}`);
  console.log(`  filters: ${JSON.stringify(j.filters, null, 1)}`);
  const f = j.failures ?? [];
  console.log(`  failures: count=${f.length}`);
  if (f.length) {
    // unique reasons
    const reasons = {};
    for (const x of f) reasons[x.reason ?? "(no reason)"] = (reasons[x.reason ?? "(no reason)"] ?? 0) + 1;
    console.log(`    reason breakdown: ${JSON.stringify(reasons)}`);
    console.log(`    sample: ${JSON.stringify(f.slice(0, 4))}`);
  }
}
