import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

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

async function get(path) {
  const resp = await fetch(`${base}${path}`, { headers });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: resp.status, json };
}

console.log("=== GET /api/campaigns?page=1 ===");
const campaignsResp = await get("/api/campaigns?page=1");
console.log("status:", campaignsResp.status);
console.log(JSON.stringify(campaignsResp.json, null, 2).slice(0, 3000));

const firstCampaign = Array.isArray(campaignsResp.json?.data) ? campaignsResp.json.data[0] : null;

if (firstCampaign) {
  const id = firstCampaign.id;
  console.log(`\n=== GET /api/campaigns/${id} ===`);
  const c = await get(`/api/campaigns/${id}`);
  console.log("status:", c.status);
  console.log(JSON.stringify(c.json, null, 2).slice(0, 3000));

  console.log(`\n=== GET /api/campaigns/${id}/schedule ===`);
  const s = await get(`/api/campaigns/${id}/schedule`);
  console.log("status:", s.status);
  console.log(JSON.stringify(s.json, null, 2).slice(0, 2000));

  console.log(`\n=== GET /api/campaigns/${id}/sequence-steps ===`);
  const seq = await get(`/api/campaigns/${id}/sequence-steps`);
  console.log("status:", seq.status);
  console.log(JSON.stringify(seq.json, null, 2).slice(0, 2000));
}

console.log("\n=== Probing sender-email list endpoint candidates ===");
const candidates = [
  "/api/sender-emails",
  "/api/sender-emails?page=1",
  "/api/accounts",
  "/api/email-accounts",
  "/api/sender-emails/list",
];
for (const path of candidates) {
  const r = await get(path);
  console.log(path, "->", r.status, typeof r.json === "string" ? r.json.slice(0, 200) : JSON.stringify(r.json).slice(0, 300));
}
