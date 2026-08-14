import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data } = await supabase.from("companies").select("revenue").not("revenue", "is", null).limit(5);
for (const row of data) {
  console.log(JSON.stringify(row.revenue), typeof row.revenue);
}
