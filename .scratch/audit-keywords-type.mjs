import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const { data, error } = await supabase
  .from("companies")
  .select("keywords, security_gateway, phone_status, phone_verified_at, email_verified_at, client, source")
  .not("keywords", "is", null)
  .limit(3);
console.log("keywords sample:", JSON.stringify(data, null, 2), error);

const { data: d2 } = await supabase
  .from("companies")
  .select("phone_status, phone_verified_at")
  .not("phone_status", "is", null)
  .limit(3);
console.log("phone_status sample:", JSON.stringify(d2, null, 2));
