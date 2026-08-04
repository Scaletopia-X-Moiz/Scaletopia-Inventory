import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: client } = await admin.from("clients").select("emailbison_api_key, emailbison_workspace_id").eq("id", "a8dfe6bc-dd09-4146-b628-fc0eacce34f3").single();
const base = client.emailbison_workspace_id;
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, "Content-Type": "application/json", Accept: "application/json" };
async function call(method, path) {
  const resp = await fetch(`${base}${path}`, { method, headers });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: resp.status, json };
}
for (const id of [1004, 1005]) {
  const get = await call("GET", `/api/campaigns/${id}`);
  console.log(`campaign ${id}: status ${get.status}, name status field:`, get.json?.data?.status ?? get.json?.message ?? JSON.stringify(get.json).slice(0,150));
}
console.log("\nFinal list:");
const list = await call("GET", "/api/campaigns");
console.log(JSON.stringify(list.json?.data?.map(c => ({id: c.id, name: c.name, status: c.status})), null, 2));
