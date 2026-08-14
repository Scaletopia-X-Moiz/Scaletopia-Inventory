import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const FULL_ROW_COLUMNS =
  "*, companies(brand_name, city, state, country, industry, employee_count, website_url, linkedin_url, domain, phone, phone_type, phone_status, email, email_status, niche, quality_tier, client, created_at, description, domain_status, email_verified_at, founded_year, keywords, last_updated, mx_provider, phone_verified_at, revenue, security_gateway, source, tags, technologies)";

async function sampleWherePersonColNonNull(col, label) {
  const { data, error } = await supabase
    .from("people")
    .select(FULL_ROW_COLUMNS)
    .not(col, "is", null)
    .limit(1);
  if (error) return console.log(`${label}: ERROR ${error.message}`);
  const row = data?.[0];
  console.log(`${label} (person.${col}): ${row ? JSON.stringify(row[col]) : "NO ROW FOUND"}`);
}

async function sampleWhereCompanyColNonNull(col, label) {
  const { data, error } = await supabase
    .from("people")
    .select(FULL_ROW_COLUMNS)
    .not(`companies.${col}`, "is", null)
    .limit(5);
  if (error) return console.log(`${label}: ERROR ${error.message}`);
  const withCompany = (data ?? []).find((r) => r.companies?.[col] != null);
  console.log(
    `${label} (companies.${col}): ${withCompany ? JSON.stringify(withCompany.companies[col]) : "NO ROW FOUND (join may need companies!inner)"}`
  );
}

console.log("--- Person-own sparse fields (via toEmailBisonPushRecord/toGhlPushRecord's exact column reads) ---");
await sampleWherePersonColNonNull("email_verified_at", "emailVerifiedAt");
await sampleWherePersonColNonNull("phone_verified_at", "phoneVerifiedAt");
await sampleWherePersonColNonNull("source_id", "sourceId");

console.log("\n--- Company* sparse fields ---");
// Use an inner join so the companies filter actually applies (PostgREST
// requires !inner for embedded-table filters to restrict the outer query).
async function sampleCompanyInner(col, label) {
  const { data, error } = await supabase
    .from("people")
    .select(
      "id, companies!inner(" + col + ")"
    )
    .not(`companies.${col}`, "is", null)
    .limit(1);
  if (error) return console.log(`${label}: ERROR ${error.message}`);
  const row = data?.[0];
  console.log(`${label} (companies.${col}): ${row ? JSON.stringify(row.companies[col]) : "NO ROW FOUND"}`);
}
await sampleCompanyInner("phone_status", "companyPhoneStatus");
await sampleCompanyInner("email_verified_at", "companyEmailVerifiedAt");
await sampleCompanyInner("phone_verified_at", "companyPhoneVerifiedAt");
await sampleCompanyInner("founded_year", "companyFoundedYear");
await sampleCompanyInner("revenue", "companyRevenue");
await sampleCompanyInner("description", "companyDescription");
await sampleCompanyInner("keywords", "companyKeywords");
await sampleCompanyInner("technologies", "companyTechnologies");
await sampleCompanyInner("security_gateway", "companySecurityGateway");

console.log("\n--- GHL-specific sparse field ---");
await sampleWherePersonColNonNull("phone_status", "phoneStatus (GHL)");
