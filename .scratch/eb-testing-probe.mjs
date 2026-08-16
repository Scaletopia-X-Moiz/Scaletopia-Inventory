import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const TESTING_ID = "0c556239-1608-41fc-9fda-89196c55a56f";
const { data: client } = await admin
  .from("clients").select("id,name,emailbison_api_key,emailbison_workspace_id").eq("id", TESTING_ID).single();
const base = (client.emailbison_workspace_id || "").replace(/\/$/, "");
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, "Content-Type": "application/json", Accept: "application/json" };
const call = async (path) => { const r = await fetch(`${base}${path}`, { headers }); const j = await r.json().catch(() => null); return { status: r.status, j }; };

console.log(`=== Testing workspace (base=${base}) ===`);
const leads = await call("/api/leads?page=1");
console.log(`  leads total: ${leads.j?.meta?.total ?? "?"}  (HTTP ${leads.status})`);
const camps = await call("/api/campaigns?page=1");
const clist = Array.isArray(camps.j?.data) ? camps.j.data.map((c) => `[${c.status}] ${c.id} ${c.name}`) : camps.j;
console.log(`  campaigns page1:`, JSON.stringify(clist).slice(0, 500));
const senders = await call("/api/sender-emails?page=1");
const slist = Array.isArray(senders.j?.data) ? senders.j.data.map((s) => `${s.id} ${s.email} [${s.status}]`) : senders.j;
console.log(`  sender-emails page1:`, JSON.stringify(slist).slice(0, 500));
const cvars = await call("/api/custom-variables?page=1");
const vlist = Array.isArray(cvars.j?.data) ? cvars.j.data.map((v) => v.name) : cvars.j;
console.log(`  custom-vars page1:`, JSON.stringify(vlist).slice(0, 500), ` last_page=${cvars.j?.meta?.last_page}`);

// Schema probe: one QA-seed company + one QA-seed person, full row.
const TAG = "claude-qa-2026-08";
const { data: coRow } = await admin.from("companies").select("*").contains("source_tokens", [TAG]).limit(1).single();
console.log(`\n=== sample QA company columns ===`);
console.log("  keys:", Object.keys(coRow).join(", "));
console.log("  values:", JSON.stringify({
  id: coRow.id, company_name: coRow.company_name, brand_name: coRow.brand_name, email: coRow.email,
  domain: coRow.domain, niche: coRow.niche, niche_tokens: coRow.niche_tokens, source: coRow.source,
  source_tokens: coRow.source_tokens, industry: coRow.industry, country: coRow.country, city: coRow.city,
  employee_count: coRow.employee_count, website_url: coRow.website_url, phone: coRow.phone,
}, null, 2));

const { data: pRow } = await admin.from("people").select("*").contains("source_tokens", [TAG]).limit(1).single();
console.log(`\n=== sample QA person columns ===`);
console.log("  keys:", Object.keys(pRow).join(", "));
console.log("  values:", JSON.stringify({
  id: pRow.id, first_name: pRow.first_name, last_name: pRow.last_name, email: pRow.email,
  company_name: pRow.company_name, company_id: pRow.company_id, niche_tokens: pRow.niche_tokens,
  source: pRow.source, source_tokens: pRow.source_tokens, city: pRow.city, state: pRow.state,
  country: pRow.country, job_title: pRow.job_title, custom_data: pRow.custom_data,
}, null, 2));

// distinct niche_tokens among QA companies (to know existing niches for filtering)
const { data: coNiches } = await admin.from("companies").select("niche").contains("source_tokens", [TAG]).limit(2000);
const nicheSet = new Set();
for (const r of coNiches ?? []) if (r.niche) nicheSet.add(r.niche);
console.log(`\n=== distinct company niche values among QA companies ===\n  `, JSON.stringify([...nicheSet]));

console.log("\nDone.");
