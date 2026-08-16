import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TESTING_ID = "0c556239-1608-41fc-9fda-89196c55a56f";
const { data, error } = await admin.from("platform_pushes").select("company_id,person_id,pushed_at,platform_contact_id,campaign_tag")
  .eq("client_id", TESTING_ID).eq("platform","emailbison").order("pushed_at",{ascending:false}).limit(20);
console.log(JSON.stringify(data,null,2), error);

// distribution of pushed_at dates
const { data: all } = await admin.from("platform_pushes").select("pushed_at").eq("client_id", TESTING_ID).eq("platform","emailbison");
const buckets = {};
for (const r of all) { const day = r.pushed_at?.slice(0,10); buckets[day] = (buckets[day]||0)+1; }
console.log("date buckets:", buckets);
