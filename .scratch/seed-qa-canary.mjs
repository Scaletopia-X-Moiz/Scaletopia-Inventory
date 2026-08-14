/**
 * CANARY — inserts a tiny throwaway batch (4 companies + 40 people) tagged
 * "claude-qa-canary" to (a) confirm every column the seed uses actually exists
 * on the live tables, and (b) confirm the UI filter predicates isolate/slice as
 * expected. Verifies, prints counts, then deletes itself. Leaves no residue.
 */
import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const TAG = "claude-qa-canary";
const NOW = new Date().toISOString();
const INDUSTRIES = ["software development", "retail"];
const pad = (n) => String(n).padStart(5, "0");

function buildCompany(i) {
  const slug = `qa-canary-co-${pad(i)}`;
  return {
    company_name: `QA Canary Co ${pad(i)}`, brand_name: `QA Canary Brand ${pad(i)}`,
    domain: `${slug}.claude-qa.example`, website_url: `https://${slug}.claude-qa.example`,
    linkedin_url: `https://www.linkedin.com/company/${slug}`,
    industry: INDUSTRIES[i % 2], industry_id: INDUSTRIES[i % 2], employee_count: [5, 350][i % 2],
    city: "Austin", state: "TX", country: "United States", country_id: "US",
    phone: `+1512555${pad(i)}`, phone_type: "mobile",
    email: `hello@${slug}.claude-qa.example`, email_status: "ok", quality_tier: "A",
    source: `${TAG} & apollo`, source_tokens: [TAG, "apollo"], client: "claude-qa",
    niche: "b2b-saas", tags: ["claude-qa-canary"], last_updated: NOW,
  };
}
function buildPerson(i, company) {
  const slug = `qa-canary-person${pad(i)}`;
  return {
    company_id: company?.id ?? null,
    first_name: "Cana", last_name: "Ryan", full_name: `Cana Ryan ${pad(i)}`,
    email: `${slug}@claude-qa.example`, phone: `+1512777${pad(i)}`,
    job_title: "CEO", linkedin_url: `https://www.linkedin.com/in/${slug}`, linkedin_username: slug,
    city: "Austin", state: "TX", country: "United States", country_id: "US",
    company_name: company?.company_name ?? null, domain: company?.domain ?? null,
    company_linkedin_url: company?.linkedin_url ?? null,
    industry_id: INDUSTRIES[i % 2], employee_count: [5, 350][i % 2],
    email_status: "ok", phone_type: "mobile",
    source: `${TAG} & apollo`, source_tokens: [TAG, "apollo"], niche_tokens: ["b2b-saas"],
    tags: ["claude-qa-canary"], last_updated: NOW,
  };
}

async function run() {
  // --- insert companies
  const companies = [];
  for (let i = 0; i < 4; i++) companies.push(buildCompany(i));
  const cRes = await admin.from("companies").insert(companies).select("id,company_name,industry_id");
  if (cRes.error) { console.error("COMPANY INSERT FAILED:", cRes.error); process.exit(1); }
  console.log("companies inserted:", cRes.data.length);

  // --- insert people (round-robin linked)
  const people = [];
  for (let i = 0; i < 40; i++) people.push(buildPerson(i, cRes.data[i % cRes.data.length]));
  const pRes = await admin.from("people").insert(people).select("id");
  if (pRes.error) { console.error("PEOPLE INSERT FAILED:", pRes.error); process.exit(1); }
  console.log("people inserted:", pRes.data.length);

  // --- VERIFY filter predicates (mirror the UI parser column mappings) ---
  const q = async (label, builder) => {
    const { count, error } = await builder;
    console.log(`  ${label}:`, error ? `ERROR ${error.message}` : count);
  };
  console.log("\n== PEOPLE predicate checks ==");
  await q("source overlap (isolation) -> expect 40",
    admin.from("people").select("*", { count: "exact", head: true }).contains("source_tokens", [TAG]));
  await q("source + industry_id=software development -> expect 20",
    admin.from("people").select("*", { count: "exact", head: true }).contains("source_tokens", [TAG]).eq("industry_id", "software development"));
  await q("source + country_id=US -> expect 40",
    admin.from("people").select("*", { count: "exact", head: true }).contains("source_tokens", [TAG]).eq("country_id", "US"));
  await q("source + employee_count>=201 -> expect 20",
    admin.from("people").select("*", { count: "exact", head: true }).contains("source_tokens", [TAG]).gte("employee_count", 201));
  await q("email ILIKE %claude-qa% (must be >=40, i.e. isolation via q also works)",
    admin.from("people").select("*", { count: "exact", head: true }).ilike("email", "%claude-qa%"));

  console.log("\n== COMPANIES predicate checks ==");
  await q("source overlap (isolation) -> expect 4",
    admin.from("companies").select("*", { count: "exact", head: true }).contains("source_tokens", [TAG]));
  await q("source + industry_id=retail -> expect 2",
    admin.from("companies").select("*", { count: "exact", head: true }).contains("source_tokens", [TAG]).eq("industry_id", "retail"));

  // --- CLEANUP ---
  const dp = await admin.from("people").delete().contains("source_tokens", [TAG]).select("id");
  const dc = await admin.from("companies").delete().contains("source_tokens", [TAG]).select("id");
  console.log(`\ncleanup deleted people=${dp.data?.length} companies=${dc.data?.length}`);
  if (dp.error || dc.error) console.error("CLEANUP ERROR", dp.error, dc.error);
}
run().catch((e) => { console.error(e); process.exit(1); });
