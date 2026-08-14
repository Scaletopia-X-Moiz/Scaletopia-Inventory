import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Target the client literally named "Internal".
const { data: clients } = await admin
  .from("clients")
  .select("id,name,emailbison_api_key,emailbison_workspace_id")
  .eq("name", "Internal");
const client = clients?.[0];
if (!client) throw new Error("No client named 'Internal'");
const base = (client.emailbison_workspace_id || "").replace(/\/$/, "");
const apiKey = client.emailbison_api_key;
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
console.log(`Internal client: ${client.id}  base=${base}`);

// All campaigns in the Internal workspace, with status.
console.log("\n=== Internal workspace campaigns (all pages) ===");
const all = [];
for (let page = 1; page <= 30; page++) {
  const r = await fetch(`${base}/api/campaigns?page=${page}`, { headers });
  const j = await r.json().catch(() => null);
  if (!r.ok) { console.log(`  page ${page} HTTP ${r.status}`, JSON.stringify(j)?.slice(0, 200)); break; }
  const rows = Array.isArray(j?.data) ? j.data : [];
  for (const row of rows) all.push({ id: row.id, name: row.name, status: row.status });
  const cur = Number(j?.meta?.current_page), last = Number(j?.meta?.last_page);
  if (Number.isNaN(cur) || Number.isNaN(last) || cur >= last) break;
}
console.log(`  total: ${all.length}`);
for (const c of all) console.log(`  [${c.status}] ${c.id}  ${c.name}`);

const drafts = all.filter((c) => String(c.status).toLowerCase() === "draft");
console.log(`\n  draft campaigns (safe, non-sending): ${JSON.stringify(drafts)}`);

// Existing custom variables in the Internal workspace.
const r2 = await fetch(`${base}/api/custom-variables`, { headers });
const j2 = await r2.json().catch(() => null);
const vars = Array.isArray(j2?.data) ? j2.data.map((v) => v.name) : [];
console.log(`\n=== Internal custom variables (page 1) HTTP ${r2.status} ===\n   ${JSON.stringify(vars)}`);

// Probe a lead read-back endpoint so Part B can verify values landed.
// Try GET /api/leads?search= and GET /api/leads/{id} shape by listing page 1.
console.log("\n=== Probe: GET /api/leads?page=1 (to learn read-back shape) ===");
const r3 = await fetch(`${base}/api/leads?page=1`, { headers });
const j3 = await r3.json().catch(() => null);
console.log(`  HTTP ${r3.status}`);
if (Array.isArray(j3?.data) && j3.data.length) {
  const sample = j3.data[0];
  console.log("  sample lead keys:", Object.keys(sample));
  console.log("  sample custom_variables field:", JSON.stringify(sample.custom_variables ?? sample.customVariables ?? "(none)").slice(0, 300));
} else {
  console.log("  body:", JSON.stringify(j3)?.slice(0, 300));
}

console.log("\nRecon2 done.");
