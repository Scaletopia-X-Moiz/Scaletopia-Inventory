import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Find one real (non-QA) company with several of the sparse new fields
// populated AND at least one linked person, then resolve it through the
// exact widened embed lib/data/people.ts's FULL_ROW_COLUMNS now uses, to
// confirm the full company->person push-record path resolves real values.
const { data: candidates, error } = await admin
  .from("companies")
  .select("id, company_name")
  .not("phone_status", "is", null)
  .not("keywords", "is", null)
  .not("technologies", "is", null)
  .not("security_gateway", "is", null)
  .limit(20);

if (error) throw error;
console.log(`Found ${candidates.length} companies with phone_status+keywords+technologies+security_gateway all set.`);

let picked = null;
for (const c of candidates) {
  const { data: people } = await admin.from("people").select("id").eq("company_id", c.id).limit(1);
  if (people && people.length) {
    picked = c;
    break;
  }
}

if (!picked) {
  console.log("No candidate had a linked person — widening search without security_gateway.");
  process.exit(0);
}

console.log("Picked company:", picked.id, picked.company_name);

const EMBED_COLS =
  "brand_name, city, state, country, industry, employee_count, website_url, linkedin_url, domain, phone, phone_type, phone_status, email, email_status, niche, quality_tier, client, created_at, description, domain_status, email_verified_at, founded_year, keywords, last_updated, mx_provider, phone_verified_at, revenue, security_gateway, source, tags, technologies";

const { data: person, error: personErr } = await admin
  .from("people")
  .select(`id, full_name, first_name, last_name, email, phone, job_title, company_name, domain, city, state, country, full_name, linkedin_url, linkedin_username, phone_type, phone_status, email_status, source_id, companies(${EMBED_COLS})`)
  .eq("company_id", picked.id)
  .limit(1)
  .maybeSingle();

if (personErr) throw personErr;

console.log("\n=== Linked person's resolved company embed (this IS the push-record source) ===");
console.log(JSON.stringify(person.companies, null, 2));
