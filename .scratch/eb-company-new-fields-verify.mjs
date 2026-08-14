import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Replicates getPeopleForEmailBisonByCompanyFilters' resolution path closely
// enough to verify: for a small QA-tagged sample of companies with linked
// people, pull the widened companies(...) embed exactly as
// lib/data/people.ts's FULL_ROW_COLUMNS now does, and confirm every NEW
// company* field resolves a real non-null value for at least one row.

const EMBED_COLS =
  "brand_name, city, state, country, industry, employee_count, website_url, linkedin_url, domain, phone, phone_type, phone_status, email, email_status, niche, quality_tier, client, created_at, description, domain_status, email_verified_at, founded_year, keywords, last_updated, mx_provider, phone_verified_at, revenue, security_gateway, source, tags, technologies";

// Pull a handful of QA companies that have linked people, with the full
// widened embed via people -> companies(...) exactly like the real resolver.
const { data, error } = await admin
  .from("people")
  .select(`id, full_name, companies(${EMBED_COLS})`)
  .contains("source_tokens", ["claude-qa-2026-08"])
  .not("company_id", "is", null)
  .limit(25);

if (error) {
  console.error("ERROR", error);
  process.exit(1);
}

console.log(`Sampled ${data.length} people with a linked company.\n`);

const NEW_FIELDS = [
  "phone_status",
  "client",
  "created_at",
  "description",
  "domain_status",
  "email_verified_at",
  "founded_year",
  "keywords",
  "last_updated",
  "mx_provider",
  "phone_verified_at",
  "revenue",
  "security_gateway",
  "source",
  "tags",
  "technologies",
];

const nonNullExample = {};
for (const row of data) {
  const c = row.companies;
  if (!c) continue;
  for (const f of NEW_FIELDS) {
    const v = c[f];
    const isEmpty = v === null || v === undefined || (Array.isArray(v) && v.length === 0);
    if (!isEmpty && !(f in nonNullExample)) {
      nonNullExample[f] = v;
    }
  }
}

console.log("=== First non-null example value found per NEW field ===");
for (const f of NEW_FIELDS) {
  console.log(f.padEnd(20), "->", f in nonNullExample ? JSON.stringify(nonNullExample[f]) : "NEVER NON-NULL IN SAMPLE");
}

console.log("\n=== Raw first row's company embed (sanity check) ===");
console.log(JSON.stringify(data[0]?.companies, null, 2));
