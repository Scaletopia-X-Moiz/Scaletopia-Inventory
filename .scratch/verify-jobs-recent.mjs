import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await admin
  .from("push_jobs")
  .select("id, client_id, platform, entity, action, campaign_id, status, total, processed, succeeded, created, updated, failed, created_at, finished_at")
  .order("created_at", { ascending: false })
  .limit(40);
if (error) throw error;

console.log(`Most recent ${data.length} push_jobs (any platform):\n`);
for (const j of data) {
  console.log(`${j.created_at} | ${j.platform} | ${j.entity} | act=${j.action} | ${j.status} | tot=${j.total} succ=${j.succeeded} cr=${j.created} up=${j.updated} fail=${j.failed} | camp=${j.campaign_id} | ${j.id}`);
}
