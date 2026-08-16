import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TESTING_ID = "0c556239-1608-41fc-9fda-89196c55a56f";

const { data: anyPushes, error: e1 } = await admin.from("platform_pushes").select("*").eq("client_id", TESTING_ID).order("pushed_at", { ascending: false }).limit(5);
console.log("recent platform_pushes for Testing:", JSON.stringify(anyPushes, null, 2), e1);

// try to find a jobs table
for (const t of ["push_jobs", "jobs", "background_jobs", "push_activity", "emailbison_jobs"]) {
  const { data, error } = await admin.from(t).select("*").order("created_at", { ascending: false }).limit(5);
  if (!error) console.log(`\n=== ${t} (recent 5) ===`, JSON.stringify(data, null, 2));
  else console.log(`\n(no table ${t}: ${error.message})`);
}
