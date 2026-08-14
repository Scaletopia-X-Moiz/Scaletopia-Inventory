/** Verify seed distributions + add 10 orphan companies (no linked people) for
 *  the "N companies -> 0 linked people" regression test. Idempotent-ish: the
 *  orphan insert is guarded so re-running won't duplicate. */
import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TAG = "claude-qa-2026-08";
const NOW = new Date().toISOString();

async function count(table, mods) {
  let qb = admin.from(table).select("*", { count: "exact", head: true }).contains("source_tokens", [TAG]);
  for (const m of mods) qb = m(qb);
  const { count, error } = await qb;
  return error ? `ERR ${error.message}` : count;
}

// --- add orphan companies (no people) if not present
const { count: orphanExisting } = await admin.from("companies").select("*", { count: "exact", head: true })
  .contains("source_tokens", [TAG]).eq("niche", "qa-orphan-nopeople");
if (!orphanExisting) {
  const orphans = Array.from({ length: 10 }, (_, i) => {
    const slug = `qa-orphan-co-${String(i + 1).padStart(3, "0")}`;
    return {
      company_name: `QA Orphan Co ${i + 1}`, brand_name: `QA Orphan Brand ${i + 1}`,
      domain: `${slug}.claude-qa.example`, website_url: `https://${slug}.claude-qa.example`,
      linkedin_url: `https://www.linkedin.com/company/${slug}`,
      industry: "software development", industry_id: "software development", employee_count: 42,
      city: "Austin", state: "TX", country: "United States", country_id: "US",
      phone: `+1512559${String(i).padStart(4, "0")}`, phone_type: "mobile",
      email: `hello@${slug}.claude-qa.example`, email_status: "ok", quality_tier: "A",
      source: `${TAG} & apollo`, source_tokens: [TAG, "apollo"], client: "claude-qa",
      niche: "qa-orphan-nopeople", tags: ["claude-qa-seed", "qa-orphan"], last_updated: NOW,
    };
  });
  const r = await admin.from("companies").insert(orphans).select("id");
  console.log("orphan companies inserted:", r.error ? r.error.message : r.data.length);
} else {
  console.log("orphan companies already present:", orphanExisting);
}

console.log("\n== PEOPLE distribution (all tagged) ==");
console.log("total:", await count("people", []));
console.log("industry=software development:", await count("people", [q => q.eq("industry_id", "software development")]));
console.log("industry=retail:", await count("people", [q => q.eq("industry_id", "retail")]));
console.log("country=US:", await count("people", [q => q.eq("country_id", "US")]));
console.log("country=GB:", await count("people", [q => q.eq("country_id", "GB")]));
console.log("employee 201-500 (>=201,<=500):", await count("people", [q => q.gte("employee_count", 201).lte("employee_count", 500)]));
console.log("employee 500+ (>=501):", await count("people", [q => q.gte("employee_count", 501)]));
console.log("emailStatus=invalid:", await count("people", [q => q.eq("email_status", "invalid")]));
console.log("emailStatus=ok:", await count("people", [q => q.eq("email_status", "ok")]));
console.log("phoneType=voip:", await count("people", [q => q.eq("phone_type", "voip")]));
console.log("niche=b2b-saas:", await count("people", [q => q.contains("niche_tokens", ["b2b-saas"])]));
console.log("job_title=CEO:", await count("people", [q => q.eq("job_title", "CEO")]));

console.log("\n== COMPANIES distribution (all tagged) ==");
console.log("total:", await count("companies", []));
console.log("country=US:", await count("companies", [q => q.eq("country_id", "US")]));
console.log("industry=software development:", await count("companies", [q => q.eq("industry_id", "software development")]));
console.log("industry=retail:", await count("companies", [q => q.eq("industry_id", "retail")]));
console.log("employee 500+ (>=501):", await count("companies", [q => q.gte("employee_count", 501)]));
console.log("niche=qa-orphan-nopeople (orphans):", await count("companies", [q => q.eq("niche", "qa-orphan-nopeople")]));

// linked-people resolution sanity: how many people link to the 50 US companies?
const { data: usCos } = await admin.from("companies").select("id").contains("source_tokens", [TAG]).eq("country_id", "US").eq("client", "claude-qa");
const usIds = (usCos ?? []).map(c => c.id);
let linked = 0;
if (usIds.length) {
  const { count: c } = await admin.from("people").select("*", { count: "exact", head: true }).in("company_id", usIds);
  linked = c;
}
console.log(`\nUS companies=${usIds.length} -> linked people=${linked} (expect ~ companies*20 minus orphans' share)`);
