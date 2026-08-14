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
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: resp.status, json };
}

const list = await call("GET", "/api/campaigns");
const all = list.json?.data ?? [];
const moizTests = all.filter((c) => c.name?.startsWith("Moiz Test"));
console.log(`Found ${moizTests.length} "Moiz Test" campaign(s) in Internal workspace:`);
for (const c of moizTests) {
  console.log(`  ${c.id}: ${c.name} (status: ${c.status})`);
}

if (process.argv[2] === "--leads" && moizTests.length) {
  for (const c of moizTests) {
    const leads = await call("GET", `/api/campaigns/${c.id}/leads`);
    const leadData = leads.json?.data ?? leads.json?.leads ?? leads.json;
    const count = Array.isArray(leadData) ? leadData.length : leadData?.total ?? "?";
    console.log(`  Campaign ${c.id} (${c.name}) leads: ${count}`);
    if (Array.isArray(leadData) && leadData.length) {
      console.log("    sample lead:", JSON.stringify(leadData[0]).slice(0, 500));
    }
  }
}
