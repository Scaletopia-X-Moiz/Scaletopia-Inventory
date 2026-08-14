import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PERSON_COLS =
  "*, companies(company_name, brand_name, domain, website_url, linkedin_url, industry, employee_count, city, state, country, phone, phone_type, phone_status, phone_verified_at, email, email_status, email_verified_at, source, niche, quality_tier, last_updated, created_at, description, founded_year, revenue, client, tags, domain_status, mx_provider, security_gateway, keywords, technologies)";

const { data: people, error } = await supabase
  .from("people")
  .select(PERSON_COLS)
  .overlaps("source_tokens", ["claude-qa-2026-08"])
  .limit(8);

if (error) {
  console.error("people query error:", error);
  process.exit(1);
}

console.log(`Fetched ${people.length} QA people rows.\n`);

// For each candidate field key, check if any of the 8 sampled rows have a non-null value.
const fieldChecks = {
  // person's own
  tags: (r) => r.tags,
  last_updated: (r) => r.last_updated,
  created_at: (r) => r.created_at,
  email_verified_at: (r) => r.email_verified_at,
  phone_verified_at: (r) => r.phone_verified_at,
  source_raw: (r) => r.source,
  source_id: (r) => r.source_id,
  source_tokens: (r) => r.source_tokens,
  employee_count_person: (r) => r.employee_count,
  industry_id_person: (r) => r.industry_id,
  company_linkedin_url_person: (r) => r.company_linkedin_url,
  // linked company
  company_description: (r) => r.companies?.description,
  company_founded_year: (r) => r.companies?.founded_year,
  company_revenue: (r) => r.companies?.revenue,
  company_client: (r) => r.companies?.client,
  company_tags: (r) => r.companies?.tags,
  company_domain_status: (r) => r.companies?.domain_status,
  company_mx_provider: (r) => r.companies?.mx_provider,
  company_security_gateway: (r) => r.companies?.security_gateway,
  company_keywords: (r) => r.companies?.keywords,
  company_technologies: (r) => r.companies?.technologies,
  company_email_verified_at: (r) => r.companies?.email_verified_at,
  company_phone_status: (r) => r.companies?.phone_status,
  company_phone_verified_at: (r) => r.companies?.phone_verified_at,
  company_last_updated: (r) => r.companies?.last_updated,
  company_created_at: (r) => r.companies?.created_at,
  company_source: (r) => r.companies?.source,
};

for (const [key, getter] of Object.entries(fieldChecks)) {
  const sampleValues = people.map(getter).filter((v) => v !== null && v !== undefined && v !== "");
  console.log(
    `${key}: ${sampleValues.length}/${people.length} non-null. sample=${JSON.stringify(sampleValues[0])}`
  );
}

console.log("\n--- Raw first row (person + company) ---");
console.log(JSON.stringify(people[0], null, 2));

console.log("\n--- Check: does person.employee_count === company.employee_count (mirror check)? ---");
for (const r of people) {
  console.log(
    `person=${r.id.slice(0, 8)} person.employee_count=${r.employee_count} company.employee_count=${r.companies?.employee_count} match=${r.employee_count === r.companies?.employee_count}`
  );
}

console.log("\n--- Check: does person.company_linkedin_url === company.linkedin_url (mirror check)? ---");
for (const r of people) {
  console.log(
    `person=${r.id.slice(0, 8)} person.company_linkedin_url=${r.company_linkedin_url} company.linkedin_url=${r.companies?.linkedin_url} match=${r.company_linkedin_url === r.companies?.linkedin_url}`
  );
}
