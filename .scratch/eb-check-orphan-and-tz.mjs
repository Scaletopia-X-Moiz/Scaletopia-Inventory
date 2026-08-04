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

async function call(method, path, body) {
  const resp = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await resp.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return { status: resp.status, json };
}

console.log("=== Full campaign list ===");
const campaigns = await call("GET", "/api/campaigns");
console.log(JSON.stringify(campaigns.json?.data?.map(c => ({id: c.id, name: c.name, status: c.status})), null, 2));

const orphan = campaigns.json?.data?.find(c => c.name.includes("CLAUDE_UI_VERIFY_DRAFT_20260804"));
console.log("\nOrphan draft campaign:", orphan ? JSON.stringify(orphan) : "NOT FOUND");

if (orphan) {
  console.log("\n=== Testing timezone values against this orphan campaign's schedule endpoint ===");
  const candidates = ["Etc/UTC", "UTC", "GMT"];
  for (const tz of candidates) {
    const r = await call("POST", `/api/campaigns/${orphan.id}/schedule`, {
      monday: true, tuesday: true, wednesday: true, thursday: true, friday: true,
      saturday: false, sunday: false,
      start_time: "09:00", end_time: "17:00",
      timezone: tz,
      save_as_template: false,
    });
    console.log(`\ntimezone="${tz}" -> status ${r.status}:`, JSON.stringify(r.json).slice(0, 300));
  }
}

console.log("\n=== Testing more timezone candidates ===");
const more = ["America/New_York", "Europe/London", "Asia/Karachi"];
for (const tz of more) {
  const r = await call("POST", `/api/campaigns/1004/schedule`, {
    monday: true, tuesday: true, wednesday: true, thursday: true, friday: true,
    saturday: false, sunday: false,
    start_time: "09:00", end_time: "17:00",
    timezone: tz,
    save_as_template: false,
  });
  console.log(`\ntimezone="${tz}" -> status ${r.status}:`, JSON.stringify(r.json).slice(0, 300));
}
