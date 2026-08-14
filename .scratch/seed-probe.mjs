import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Sample one people + one companies row to see the full column set.
const p = await admin.from("people").select("*").limit(1);
const c = await admin.from("companies").select("*").limit(1);
console.log("PEOPLE columns:", p.error ? p.error : Object.keys(p.data[0] ?? {}));
console.log("COMPANIES columns:", c.error ? c.error : Object.keys(c.data[0] ?? {}));

// Counts
const pc = await admin.from("people").select("id", { count: "exact", head: true });
const cc = await admin.from("companies").select("id", { count: "exact", head: true });
console.log("people count:", pc.count, "companies count:", cc.count);

// Distinct-ish sample of email_status / phone_type values actually in use.
const es = await admin.from("people").select("email_status").not("email_status", "is", null).limit(2000);
const pt = await admin.from("people").select("phone_type").not("phone_type", "is", null).limit(2000);
console.log("email_status values:", [...new Set((es.data ?? []).map(r => r.email_status))]);
console.log("phone_type values:", [...new Set((pt.data ?? []).map(r => r.phone_type))]);

// Clients (for push target reference)
const cl = await admin.from("clients").select("id,name,is_active").limit(20);
console.log("clients:", cl.error ? cl.error : cl.data);
