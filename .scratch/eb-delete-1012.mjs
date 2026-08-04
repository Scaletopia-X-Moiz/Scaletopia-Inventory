import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLIENT_ID = "a8dfe6bc-dd09-4146-b628-fc0eacce34f3"; // Internal

const { data: client, error } = await admin
  .from("clients")
  .select("emailbison_api_key, emailbison_workspace_id")
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

console.log("=== Deleting campaign 1012 ===");
console.log(JSON.stringify(await call("DELETE", "/api/campaigns/1012"), null, 2));

for (let i = 0; i < 6; i++) {
  await new Promise((r) => setTimeout(r, 5000));
  const r = await call("GET", "/api/campaigns/1012");
  console.log(`poll ${i}: status ${r.status}`, JSON.stringify(r.json)?.slice(0, 200));
  if (r.status === 404) { console.log("Confirmed deleted."); break; }
}
