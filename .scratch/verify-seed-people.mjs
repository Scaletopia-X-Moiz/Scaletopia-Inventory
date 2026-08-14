import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "fs";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const PAGE = 1000;
async function fetchAll(build) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(admin).range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}

const people = await fetchAll((a) =>
  a.from("people")
    .select("id,email,company_name,company_id,niche_tokens,country_id,industry_id,job_title,companies(brand_name,company_name)")
    .contains("source_tokens", ["claude-qa-2026-08"])
    .order("email", { ascending: true, nullsFirst: false })
);

console.log("Total seed people:", people.length);
const withEmail = people.filter((p) => p.email);
const noEmail = people.filter((p) => !p.email);
console.log("  with email:", withEmail.length, " no email:", noEmail.length);

function group(pred) { return people.filter(pred); }
const softwareDev = group((p) => p.industry_id === "software development");
const ca = group((p) => p.country_id === "CA");
const gbSoft = group((p) => p.country_id === "GB" && p.industry_id === "software development");
const uncleaned = group((p) => (p.niche_tokens ?? []).includes("qa-uncleaned"));
const noemailNiche = group((p) => (p.niche_tokens ?? []).includes("qa-noemail"));
const deRetail = group((p) => p.country_id === "DE" && p.industry_id === "retail");
const hospitality = group((p) => p.industry_id === "hospitality");
const eduUs = group((p) => p.country_id === "US" && p.industry_id === "education");

const stat = (label, arr) => {
  const emails = arr.filter((p) => p.email).length;
  console.log(`  ${label}: total=${arr.length} withEmail=${emails} noEmail=${arr.length - emails}`);
};
console.log("\n=== Scenario populations (Supabase) ===");
stat("S1 software development", softwareDev);
stat("S3 country=CA", ca);
stat("S2 GB & software-dev", gbSoft);
stat("S4 niche qa-uncleaned", uncleaned);
stat("S6 niche qa-noemail", noemailNiche);
stat("S5 DE & retail", deRetail);
stat("S7 hospitality", hospitality);
stat("S10 US & education", eduUs);

// brand_name presence for uncleaned & DE-retail companies
const uncCompanyBrandNull = uncleaned.filter((p) => p.companies && p.companies.brand_name === null).length;
const uncCompanyBrandSet = uncleaned.filter((p) => p.companies && p.companies.brand_name).length;
const uncNoCompany = uncleaned.filter((p) => !p.company_id).length;
console.log(`\nS4 uncleaned linked-company brand_name: null=${uncCompanyBrandNull} set=${uncCompanyBrandSet} noCompany=${uncNoCompany}`);
console.log("  sample uncleaned:", JSON.stringify(uncleaned.slice(0,3).map(p=>({email:p.email,company_name:p.company_name,brand:p.companies?.brand_name}))));

const deBrandSet = deRetail.filter((p) => p.companies && p.companies.brand_name).length;
console.log(`\nS5 DE-retail linked-company brand_name set=${deBrandSet} of ${deRetail.length}`);
console.log("  sample DE-retail:", JSON.stringify(deRetail.slice(0,3).map(p=>({email:p.email,company_name:p.company_name,brand:p.companies?.brand_name}))));

// Save sample emails for EB lookup
const samples = {
  softwareDev: softwareDev.filter(p=>p.email).slice(0, 12).map(p=>p.email),
  ca: ca.filter(p=>p.email).slice(0, 12).map(p=>p.email),
  gbSoft: gbSoft.filter(p=>p.email).slice(0, 12).map(p=>p.email),
  uncleaned: uncleaned.filter(p=>p.email).map(p=>p.email), // all, for blank-company check
  uncleanedMeta: uncleaned.filter(p=>p.email).map(p=>({email:p.email,company_name:p.company_name})),
  noemail: noemailNiche.map(p=>({email:p.email,name:p.job_title,id:p.id})).slice(0,5),
  deRetail: deRetail.filter(p=>p.email).slice(0, 12).map(p=>({email:p.email,company_name:p.company_name,brand:p.companies?.brand_name})),
  hospitality: hospitality.filter(p=>p.email).slice(0, 12).map(p=>p.email),
  eduUs: eduUs.filter(p=>p.email).slice(0, 12).map(p=>p.email),
};
writeFileSync("D:/Scaletopia/Scaletopia-Inventory/.scratch/verify-samples.json", JSON.stringify(samples, null, 2));
console.log("\nWrote verify-samples.json");
