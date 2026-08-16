import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TAG = "claude-qa-2026-08";
const c = (t) => admin.from(t).select("id", { count: "exact", head: true }).contains("source_tokens", [TAG]);

// A4: b2b-saas companies array columns
const { data: b2b } = await admin.from("companies")
  .select("company_name,brand_name,email,industry,keywords,technologies,founded_year,revenue")
  .contains("source_tokens", [TAG]).eq("niche", "b2b-saas").limit(3);
console.log("=== companies niche=b2b-saas sample ===");
for (const r of b2b ?? []) console.log(`  ${r.company_name} | kw=${JSON.stringify(r.keywords)} tech=${JSON.stringify(r.technologies)} founded=${r.founded_year} rev=${JSON.stringify(r.revenue)} ind=${r.industry}`);
const { count: b2bTotal } = await c("companies").eq("niche", "b2b-saas");
const { count: b2bKw } = await c("companies").eq("niche", "b2b-saas").not("keywords", "is", null);
const { count: b2bFoundedNull } = await c("companies").eq("niche", "b2b-saas").is("founded_year", null);
console.log(`  total=${b2bTotal} withKeywords=${b2bKw} foundedYearNull=${b2bFoundedNull}`);

// D-slice: companies country_id=DE
const { count: de } = await c("companies").eq("country_id", "DE");
const { data: deS } = await admin.from("companies").select("company_name,brand_name,email,country_id").contains("source_tokens", [TAG]).eq("country_id", "DE").limit(3);
console.log(`\n=== companies country_id=DE: ${de} ===`);
for (const r of deS ?? []) console.log(`  ${r.company_name} | brand=${r.brand_name} email=${r.email} country_id=${r.country_id}`);

// G1: industry filter. distribution of industry_id among QA companies
const { data: inds } = await admin.from("companies").select("industry,industry_id").contains("source_tokens", [TAG]).limit(600);
const m = new Map();
for (const r of inds ?? []) { const k = r.industry_id ?? "(null)"; m.set(k, (m.get(k) ?? 0) + 1); }
console.log("\n=== company industry_id distribution ===");
for (const [k, v] of [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12)) console.log(`  ${v.toString().padStart(4)}  ${k}`);

// B3: people country_id=CA
const { count: caPpl } = await c("people").eq("country_id", "CA");
console.log(`\n=== people country_id=CA: ${caPpl} ===`);

// B4 mixed: qa-noemail + qa-uncleaned (OR via niche_tokens)
const { count: noemail } = await c("people").contains("niche_tokens", ["qa-noemail"]);
const { count: uncleaned } = await c("people").contains("niche_tokens", ["qa-uncleaned"]);
console.log(`\n=== mixed batch B4 (niche=qa-noemail OR qa-uncleaned) ===`);
console.log(`  qa-noemail(no email)=${noemail}  qa-uncleaned(with email)=${uncleaned}  => total ~${noemail + uncleaned}, ~${uncleaned} succeed / ${noemail} fail`);

// people country_id GB (for reference / integrity variety)
const { count: gbPpl } = await c("people").eq("country_id", "GB");
console.log(`\n  (ref) people country_id=GB: ${gbPpl}`);
console.log("\nDone.");
