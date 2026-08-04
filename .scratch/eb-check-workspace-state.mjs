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

console.log("=== Sender emails ===");
const senders = await call("GET", "/api/sender-emails");
console.log("status:", senders.status);
console.log(JSON.stringify(senders.json?.data?.map(s => ({id: s.id, name: s.name, email: s.email})), null, 2));

console.log("\n=== Campaigns (page 1) ===");
const campaigns = await call("GET", "/api/campaigns");
console.log("status:", campaigns.status);
const list = campaigns.json?.data ?? [];
console.log(JSON.stringify(list.map(c => ({id: c.id, name: c.name, status: c.status})), null, 2));
console.log("meta:", JSON.stringify(campaigns.json?.meta));

const stray = list.find(c => c.name === "CLAUDE_API_TEST - delete me");
console.log("\nStray campaign found:", stray ? JSON.stringify(stray) : "NOT FOUND (already gone or not on page 1)");
