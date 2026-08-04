import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLIENT_ID = "a8dfe6bc-dd09-4146-b628-fc0eacce34f3"; // Internal

const { data: client, error } = await admin
  .from("clients")
  .select("id, name, emailbison_api_key, emailbison_workspace_id")
  .eq("id", CLIENT_ID)
  .single();
if (error) throw error;

const base = client.emailbison_workspace_id;
const headers = {
  Authorization: `Bearer ${client.emailbison_api_key}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};
async function call(method, path, body) {
  const resp = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: resp.status, json };
}

console.log("=== Current campaign list (Internal workspace) ===");
const campaigns = await call("GET", "/api/campaigns");
console.log(JSON.stringify(campaigns.json?.data?.map(c => ({ id: c.id, name: c.name, status: c.status, total_leads: c.total_leads })), null, 2));

console.log("\n=== QA fixture people ===");
const { data: people } = await admin
  .from("people")
  .select("id, first_name, last_name, email, phone_type, phone_status, pushed_to_ghl, custom_data")
  .ilike("email", "claude-qa-test-%@scaletopia.local");
console.log(JSON.stringify(people, null, 2));

console.log("\n=== QA fixture company ===");
const { data: companies } = await admin
  .from("companies")
  .select("id, name")
  .ilike("name", "%QA%")
  .limit(10);
console.log(JSON.stringify(companies, null, 2));
