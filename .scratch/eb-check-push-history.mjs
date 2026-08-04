import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data, error } = await admin
  .from("platform_pushes")
  .select("*")
  .in("person_id", ["f810364f-accf-4cd1-bfb1-45830681a41e", "664a6dbb-9f7a-4577-b3cd-8c51f945e3ca", "a232550a-1e6f-4df6-b519-6f833e509d6a"])
  .order("pushed_at", { ascending: false })
  .limit(20);
if (error) console.error(error);
console.log(JSON.stringify(data, null, 2));
