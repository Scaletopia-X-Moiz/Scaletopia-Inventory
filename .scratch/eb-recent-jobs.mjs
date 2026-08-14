import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await admin
  .from("push_jobs")
  .select("id, platform, entity, action, status, total, processed, succeeded, created, updated, failed, filters, error, created_at")
  .in("platform", ["emailbison_companies", "emailbison_people", "emailbison_campaign"])
  .order("created_at", { ascending: false })
  .limit(12);
if (error) throw error;

for (const j of data) {
  console.log("─".repeat(60));
  console.log(`${j.created_at} ${j.platform} entity=${j.entity} action=${j.action} status=${j.status}`);
  console.log(`  total=${j.total} processed=${j.processed} succ=${j.succeeded} created=${j.created} updated=${j.updated} failed=${j.failed}`);
  if (j.error) console.log("  error:", j.error);
  console.log("  filters:", JSON.stringify(j.filters));
}
