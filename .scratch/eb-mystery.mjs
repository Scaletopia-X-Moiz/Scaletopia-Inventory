import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TESTING_ID = "0c556239-1608-41fc-9fda-89196c55a56f";
const { data: client } = await admin.from("clients").select("emailbison_api_key,emailbison_workspace_id").eq("id", TESTING_ID).single();
const base = (client.emailbison_workspace_id || "").replace(/\/$/, "");
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, Accept: "application/json" };
// pull a few pages, look at created_at range and first_name pattern
let sample = [];
for (const p of [1,2,50,100,200,295]) {
  const r = await fetch(`${base}/api/leads?search=claude-qa&page=${p}`, { headers });
  const j = await r.json().catch(()=>null);
  for (const l of (j?.data ?? [])) sample.push({ id:l.id, email:l.email, fn:l.first_name, ln:l.last_name, created:l.created_at });
}
console.log(JSON.stringify(sample, null, 2));
