import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: client } = await admin.from("clients").select("name, emailbison_api_key, emailbison_workspace_id").eq("id", "a8dfe6bc-dd09-4146-b628-fc0eacce34f3").single();
const base = client.emailbison_workspace_id;
console.log("client:", client.name, "base:", base);
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, "Content-Type": "application/json", Accept: "application/json" };
async function call(method, path, body) {
  const resp = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: resp.status, json };
}

// custom variables list
console.log("\n=== custom-variables ===");
const cv = await call("GET", "/api/custom-variables");
const names = Array.isArray(cv.json?.data) ? cv.json.data.map(v=>v.name) : cv.json;
console.log("HTTP", cv.status, "names:", JSON.stringify(names));

// search a claude-qa lead
console.log("\n=== search leads person00001 ===");
const r = await call("GET", "/api/leads?search=person00001@claude-qa.example");
console.log("HTTP", r.status);
const d = r.json?.data ?? r.json;
if (Array.isArray(d)) {
  console.log("count:", d.length);
  console.log("FULL first lead:", JSON.stringify(d[0], null, 2));
} else {
  console.log(JSON.stringify(r.json, null, 2).slice(0, 2000));
}
