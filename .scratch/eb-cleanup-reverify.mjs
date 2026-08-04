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

const ids = [1006, 1007, 1008, 1009, 1010, 1011];

for (const id of ids) {
  const del = await call("DELETE", `/api/campaigns/${id}`);
  console.log(`DELETE ${id}:`, del.status, JSON.stringify(del.json).slice(0, 200));
}

console.log("\nWaiting 15s for async deletion queue...");
await new Promise((r) => setTimeout(r, 15000));

for (const id of ids) {
  const get = await call("GET", `/api/campaigns/${id}`);
  console.log(`GET ${id} after delete:`, get.status, get.status === 404 ? "(gone, confirmed)" : JSON.stringify(get.json).slice(0, 200));
}

console.log("\nFull campaign list check:");
const list = await call("GET", "/api/campaigns");
const names = (list.json?.data ?? []).map((c) => `${c.id}:${c.name}`);
const stillPresent = ids.filter((id) => names.some((n) => n.startsWith(`${id}:`)));
console.log("Still present in list:", stillPresent);
console.log("All names:", names.slice(0, 15));
