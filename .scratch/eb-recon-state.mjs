import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// 1) Clients with EmailBison creds
const { data: clients, error: cErr } = await admin
  .from("clients")
  .select("id,name,emailbison_api_key,emailbison_workspace_id")
  .not("emailbison_api_key", "is", null)
  .not("emailbison_workspace_id", "is", null);
if (cErr) { console.error("clients err", cErr); process.exit(1); }
console.log(`=== ${clients.length} client(s) with EB creds ===`);
for (const c of clients) {
  console.log(`  ${c.name}  id=${c.id}  base=${c.emailbison_workspace_id}  keyLen=${c.emailbison_api_key?.length}`);
}

// 2) QA seed presence
const TAG = "claude-qa-2026-08";
const { count: ppl } = await admin
  .from("people")
  .select("id", { count: "exact", head: true })
  .contains("source_tokens", [TAG]);
const { count: cos } = await admin
  .from("companies")
  .select("id", { count: "exact", head: true })
  .contains("source_tokens", [TAG]);
console.log(`\n=== QA seed (${TAG}) ===`);
console.log(`  people:    ${ppl}`);
console.log(`  companies: ${cos}`);

// 3) Lead read-back shape from the Internal (or first) client
const client = clients.find((c) => c.name === "Internal") ?? clients[0];
if (client) {
  const base = (client.emailbison_workspace_id || "").replace(/\/$/, "");
  const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, "Content-Type": "application/json", Accept: "application/json" };
  console.log(`\n=== Lead read-back shape from client '${client.name}' ===`);
  const r = await fetch(`${base}/api/leads?page=1`, { headers });
  const j = await r.json().catch(() => null);
  console.log(`  GET /api/leads?page=1 -> HTTP ${r.status}`);
  if (Array.isArray(j?.data) && j.data.length) {
    const s = j.data[0];
    console.log("  keys:", Object.keys(s).join(", "));
    console.log("  custom_variables sample:", JSON.stringify(s.custom_variables ?? s.customVariables ?? "(none)").slice(0, 500));
    console.log("  meta:", JSON.stringify(j.meta ?? "(none)"));
  } else {
    console.log("  body:", JSON.stringify(j)?.slice(0, 400));
  }
}
console.log("\nDone.");
