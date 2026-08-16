import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TAG = "claude-qa-2026-08";

async function sampleNiche(niche, n = 5) {
  const { data } = await admin.from("people")
    .select("id,first_name,last_name,email,city,state,country,job_title,company_id,company_name,custom_data,niche_tokens")
    .contains("source_tokens", [TAG]).contains("niche_tokens", [niche]).limit(n);
  return data ?? [];
}

for (const niche of ["qa-uncleaned", "agency", "qa-noemail"]) {
  const rows = await sampleNiche(niche, 3);
  console.log(`\n=== people niche=${niche} (sample ${rows.length}) ===`);
  for (const r of rows) {
    console.log(`  ${r.email ?? "(no email)"} | city=${r.city} state=${r.state} country=${r.country} title=${r.job_title} company_id=${r.company_id ? "yes" : "null"} company_name=${r.company_name}`);
  }
  // completeness across the whole niche
  const base = () => admin.from("people").select("id", { count: "exact", head: true }).contains("source_tokens", [TAG]).contains("niche_tokens", [niche]);
  const { count: total } = await base();
  const { count: withEmail } = await base().not("email", "is", null);
  const { count: withCity } = await base().not("city", "is", null);
  const { count: withCompany } = await base().not("company_id", "is", null);
  console.log(`  totals: total=${total} withEmail=${withEmail} withCity=${withCity} withCompanyId=${withCompany}`);
}

// For qa-uncleaned people, inspect their linked company's brand/domain/employees (embed source for companyDomain/companyEmployeeCount)
const { data: up } = await admin.from("people").select("id,company_id").contains("source_tokens", [TAG]).contains("niche_tokens", ["qa-uncleaned"]).not("company_id", "is", null).limit(3);
for (const p of up ?? []) {
  const { data: co } = await admin.from("companies").select("company_name,brand_name,domain,employee_count,industry").eq("id", p.company_id).single();
  console.log(`  linked company for person ${p.id}: name=${co?.company_name} brand=${co?.brand_name} domain=${co?.domain} employees=${co?.employee_count} industry=${co?.industry}`);
}
console.log("\nDone.");
