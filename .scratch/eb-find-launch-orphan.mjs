import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
const CLIENT_ID = "a8dfe6bc-dd09-4146-b628-fc0eacce34f3";
const { data: client } = await admin
  .from("clients")
  .select("emailbison_api_key, emailbison_workspace_id")
  .eq("id", CLIENT_ID)
  .single();
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
const campaigns = await call("GET", "/api/campaigns");
console.log(JSON.stringify(campaigns.json?.data?.map(c => ({id: c.id, name: c.name, status: c.status})), null, 2));
