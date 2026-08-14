import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const EMBED_COLS =
  "brand_name, city, state, country, industry, employee_count, website_url, linkedin_url, domain, phone, phone_type, phone_status, email, email_status, niche, quality_tier, client, created_at, description, domain_status, email_verified_at, founded_year, keywords, last_updated, mx_provider, phone_verified_at, revenue, security_gateway, source, tags, technologies";

const FIELDS = [
  "phone_status",
  "description",
  "email_verified_at",
  "founded_year",
  "keywords",
  "phone_verified_at",
  "revenue",
  "security_gateway",
  "technologies",
];

// For each sparse field independently, find a person whose linked company has
// that field set, and confirm the embed resolves it.
for (const f of FIELDS) {
  const { data: people, error } = await admin
    .from("people")
    .select(`id, full_name, company_id, companies!inner(${EMBED_COLS})`)
    .not(`companies.${f}`, "is", null)
    .limit(1);
  if (error) {
    console.log(f, "QUERY ERROR:", error.message);
    continue;
  }
  if (!people || people.length === 0) {
    console.log(f.padEnd(20), "-> NO LINKED PERSON FOUND with this field set (red flag)");
    continue;
  }
  const val = people[0].companies[f];
  console.log(f.padEnd(20), "-> resolved via person embed:", JSON.stringify(val));
}
