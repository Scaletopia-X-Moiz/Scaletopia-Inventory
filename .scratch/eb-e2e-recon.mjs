import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// 1) Which clients have EmailBison credentials?
const { data: clients, error: cErr } = await admin
  .from("clients")
  .select("id,name,emailbison_api_key,emailbison_workspace_id,is_active")
  .not("emailbison_api_key", "is", null);
if (cErr) throw cErr;
console.log("=== Clients with EmailBison creds ===");
for (const c of clients ?? []) {
  console.log(
    `  ${c.name} (${c.id}) active=${c.is_active} base=${c.emailbison_workspace_id} key=${(c.emailbison_api_key || "").slice(0, 6)}…`
  );
}
if (!clients?.length) {
  console.log("No credentialed client — cannot do a live push.");
  process.exit(0);
}

// Prefer an active client; fall back to the first.
const client = clients.find((c) => c.is_active) ?? clients[0];
const base = (client.emailbison_workspace_id || "").replace(/\/$/, "");
const apiKey = client.emailbison_api_key;
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" };
console.log(`\nUsing client: ${client.name} (${client.id}) base=${base}`);

// 2) Find the "internal" campaign (walk pages).
console.log("\n=== Campaigns (searching for 'internal') ===");
let internal = null;
const seen = [];
for (let page = 1; page <= 20; page++) {
  const r = await fetch(`${base}/api/campaigns?page=${page}`, { headers });
  const j = await r.json().catch(() => null);
  if (!r.ok) {
    console.log(`  campaigns page ${page} -> HTTP ${r.status}`, JSON.stringify(j)?.slice(0, 200));
    break;
  }
  const rows = Array.isArray(j?.data) ? j.data : [];
  for (const row of rows) {
    seen.push({ id: row.id, name: row.name, status: row.status });
    if (String(row.name).trim().toLowerCase() === "internal") internal = { id: String(row.id), name: row.name, status: row.status };
  }
  const cur = Number(j?.meta?.current_page), last = Number(j?.meta?.last_page);
  if (Number.isNaN(cur) || Number.isNaN(last) || cur >= last) break;
}
console.log(`  total campaigns seen: ${seen.length}`);
console.log("  first 15:", JSON.stringify(seen.slice(0, 15)));
console.log(internal ? `  ✓ FOUND 'internal': ${JSON.stringify(internal)}` : "  ✗ no campaign literally named 'internal'");

// 3) Existing custom variables (so we know which names already exist).
const r2 = await fetch(`${base}/api/custom-variables`, { headers });
const j2 = await r2.json().catch(() => null);
const vars = Array.isArray(j2?.data) ? j2.data.map((v) => v.name) : [];
console.log(`\n=== Custom variables (page 1) HTTP ${r2.status} ===`);
console.log("  ", JSON.stringify(vars));

// 4) Find a couple of companies with city/state/industry populated AND linked people.
console.log("\n=== Sample companies with populated location + linked people ===");
const { data: comps, error: compErr } = await admin
  .from("companies")
  .select("id,company_name,brand_name,city,state,country,industry,employee_count,quality_tier")
  .not("city", "is", null)
  .not("state", "is", null)
  .not("industry", "is", null)
  .limit(50);
if (compErr) throw compErr;

let picked = [];
for (const co of comps ?? []) {
  const { data: ppl } = await admin
    .from("people")
    .select("id,first_name,last_name,email,city,state,country")
    .eq("company_id", co.id)
    .not("email", "is", null)
    .limit(2);
  if (ppl && ppl.length) {
    picked.push({ company: co, people: ppl });
    if (picked.length >= 2) break;
  }
}
for (const p of picked) {
  console.log(`  COMPANY ${p.company.company_name} (${p.company.id})`);
  console.log(`    city=${p.company.city} state=${p.company.state} country=${p.company.country} industry=${p.company.industry} emp=${p.company.employee_count} tier=${p.company.quality_tier}`);
  for (const person of p.people) {
    console.log(`    PERSON ${person.first_name} ${person.last_name} <${person.email}> city=${person.city} state=${person.state}`);
  }
}
if (!picked.length) console.log("  (none found in first 50 — will widen if needed)");

console.log("\nRecon done.");
