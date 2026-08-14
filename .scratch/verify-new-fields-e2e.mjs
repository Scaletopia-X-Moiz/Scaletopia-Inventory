import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Mirrors lib/data/people.ts's FULL_ROW_COLUMNS exactly.
const FULL_ROW_COLUMNS =
  "*, companies(brand_name, city, state, country, industry, employee_count, website_url, linkedin_url, domain, phone, phone_type, phone_status, email, email_status, niche, quality_tier, client, created_at, description, domain_status, email_verified_at, founded_year, keywords, last_updated, mx_provider, phone_verified_at, revenue, security_gateway, source, tags, technologies)";

const { data: rows, error } = await supabase
  .from("people")
  .select(FULL_ROW_COLUMNS)
  .overlaps("source_tokens", ["claude-qa-2026-08"])
  .limit(500);

if (error) {
  console.error(error);
  process.exit(1);
}

console.log(`Fetched ${rows.length} QA people rows for e2e resolver verification.\n`);

// Mirrors toEmailBisonPushRecord's NEW fields only (person-own additions).
function newEmailBisonPersonFields(row) {
  return {
    tags: row.tags,
    emailVerifiedAt: row.email_verified_at,
    phoneVerifiedAt: row.phone_verified_at,
    lastUpdated: row.last_updated,
    createdAt: row.created_at,
  };
}

// Mirrors the company* fields already added by the other agent (spot check).
function companyStarFields(row) {
  const c = row.companies;
  return {
    companyPhoneStatus: c?.phone_status ?? null,
    companyClient: c?.client ?? null,
    companyCreatedAt: c?.created_at ?? null,
    companyDescription: c?.description ?? null,
    companyDomainStatus: c?.domain_status ?? null,
    companyEmailVerifiedAt: c?.email_verified_at ?? null,
    companyFoundedYear: c?.founded_year ?? null,
    companyKeywords: c?.keywords ?? null,
    companyLastUpdated: c?.last_updated ?? null,
    companyMxProvider: c?.mx_provider ?? null,
    companyPhoneVerifiedAt: c?.phone_verified_at ?? null,
    companyRevenue: c?.revenue ?? null,
    companySecurityGateway: c?.security_gateway ?? null,
    companySource: c?.source ?? null,
    companyTags: c?.tags ?? null,
    companyTechnologies: c?.technologies ?? null,
  };
}

// Mirrors toGhlPushRecord's NEW fields (person-own additions specific to GHL,
// i.e. previously entirely absent from GhlPushRecord).
function newGhlPersonFields(row) {
  return {
    title: row.job_title,
    website: row.domain,
    state: row.state,
    fullName: row.full_name,
    linkedinUrl: row.linkedin_url,
    linkedinUsername: row.linkedin_username,
    phoneType: row.phone_type,
    phoneStatus: row.phone_status,
    emailStatus: row.email_status,
    sourceId: row.source_id,
  };
}

function report(label, fn) {
  const results = {};
  for (const row of rows) {
    const values = fn(row);
    for (const [key, value] of Object.entries(values)) {
      if (!results[key]) results[key] = { nonNull: 0, sample: undefined };
      const isNonNull =
        value !== null &&
        value !== undefined &&
        !(Array.isArray(value) && value.length === 0);
      if (isNonNull) {
        results[key].nonNull++;
        if (results[key].sample === undefined) results[key].sample = value;
      }
    }
  }
  console.log(`\n=== ${label} ===`);
  for (const [key, { nonNull, sample }] of Object.entries(results)) {
    const flag = nonNull === 0 ? "  <<< ALL NULL (red flag)" : "";
    console.log(
      `${key}: ${nonNull}/${rows.length} non-null. sample=${JSON.stringify(sample)}${flag}`
    );
  }
}

report("EmailBison NEW person-own fields", newEmailBisonPersonFields);
report("EmailBison company* fields (other agent's additions, spot-check)", companyStarFields);
report("GHL NEW person-own fields", newGhlPersonFields);
