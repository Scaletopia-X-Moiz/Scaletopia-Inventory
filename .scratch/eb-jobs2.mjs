import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TESTING_ID = "0c556239-1608-41fc-9fda-89196c55a56f";
const { count } = await admin.from("push_jobs").select("*", {count:"exact", head:true}).eq("client_id", TESTING_ID);
console.log("total push_jobs rows for Testing:", count);
const { data } = await admin.from("push_jobs").select("id,created_at,entity,action,status,total,succeeded,failed").eq("client_id", TESTING_ID).order("created_at",{ascending:false}).limit(10);
console.log(JSON.stringify(data,null,2));
// also check platform_pushes recent activity for Testing
const { data: pp, error } = await admin.from("platform_pushes").select("pushed_at").eq("client_id", TESTING_ID).eq("platform","emailbison").order("pushed_at",{ascending:false}).limit(5);
console.log("recent platform_pushes:", JSON.stringify(pp,null,2), error);
