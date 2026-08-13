// Verify the variant_from_step linkage actually persisted, via alternate read endpoints.
import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: client } = await admin.from("clients").select("emailbison_api_key, emailbison_workspace_id").eq("id", "a8dfe6bc-dd09-4146-b628-fc0eacce34f3").single();
const base = client.emailbison_workspace_id;
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, "Content-Type": "application/json", Accept: "application/json" };
async function call(method, path, body) {
  const resp = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await resp.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: resp.status, json };
}
const CAMP = 1051; // the zzz-VCONFIRM campaign with variant linked (step 2433 -> base 2432)

for (const p of [
  `/api/campaigns/v1.1/${CAMP}/sequence-steps`,
  `/api/campaigns/${CAMP}/sequence-steps`,
  `/api/campaigns/${CAMP}`,
]) {
  const r = await call("GET", p);
  console.log(`\n=== GET ${p} [HTTP ${r.status}] ===`);
  console.log(JSON.stringify(r.json, null, 2).slice(0, 2500));
}
