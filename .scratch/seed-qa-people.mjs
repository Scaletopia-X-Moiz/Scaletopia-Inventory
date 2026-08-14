/**
 * QA SEED SCRIPT — inserts ~500 companies + ~10,000 people into the LIVE
 * Supabase DB so a human can push filterable slices to EmailBison via the UI.
 *
 * SAFE TO RE-READ, DESTRUCTIVE TO RUN. Nothing is inserted until you run:
 *     node .scratch/seed-qa-people.mjs
 *
 * Everything is tagged with SEED_TAG so it can be deleted cleanly afterward
 * (see the cleanup block at the bottom of this file / the report).
 *
 * Connection pattern is copied verbatim from the working .scratch/*.mjs scripts
 * (dotenv -> .env.local, service-role createClient).
 */
import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ---- Distinctive markers for cleanup -------------------------------------
const SEED_TAG = "claude-qa-2026-08";      // lands in source_tokens on every row
const SEED_TAGS = ["claude-qa-seed", "qa", "2026-08-15"]; // tags[] on every row
const EMAIL_DOMAIN = "claude-qa.example";  // every email/domain ends with this
const NOW = new Date().toISOString();

const PEOPLE_TOTAL = 10000;
const COMPANY_TOTAL = 500;
const BATCH = 500;

// ---- Filterable dimensions (each yields a clean single-filter slice) ------
// country_id must be the canonical uppercase id (lib/data/country.ts).
const COUNTRIES = [
  { id: "US", raw: "United States", city: "Austin", state: "TX" },
  { id: "GB", raw: "United Kingdom", city: "London", state: "England" },
  { id: "CA", raw: "Canada", city: "Toronto", state: "ON" },
  { id: "AU", raw: "Australia", city: "Sydney", state: "NSW" },
  { id: "DE", raw: "Germany", city: "Berlin", state: "Berlin" },
  { id: "FR", raw: "France", city: "Paris", state: "IDF" },
  { id: "IN", raw: "India", city: "Mumbai", state: "MH" },
  { id: "NL", raw: "Netherlands", city: "Amsterdam", state: "NH" },
  { id: "ES", raw: "Spain", city: "Madrid", state: "MD" },
  { id: "IT", raw: "Italy", city: "Milan", state: "MI" },
];
// industry_id must be the canonical lowercased key (lib/data/industry.ts).
const INDUSTRIES = [
  "software development",
  "marketing and advertising",
  "financial services",
  "health care",
  "retail",
  "real estate",
  "education",
  "hospitality",
  "manufacturing",
  "construction",
];
// Varied canonical source token (in addition to the constant SEED_TAG marker).
const SOURCES = ["apollo", "aiark", "blitz", "clay", "store-leads"];
const NICHES = ["dtc-beauty", "b2b-saas", "ecommerce", "agency", "fitness"];
// One representative count inside each EMPLOYEE_BUCKETS range (lib/data/employee-size.ts).
const EMP_COUNTS = [5, 30, 120, 350, 1200]; // -> 1-10, 11-50, 51-200, 201-500, 500+
const EMAIL_STATUSES = ["ok", "catch_all", "invalid"];
const PHONE_TYPES = ["mobile", "voip", "fixed_line", "fixed_line_or_mobile"];
const JOB_TITLES = [
  "CEO", "CTO", "VP Marketing", "Head of Growth", "Founder",
  "Sales Manager", "Marketing Director", "Operations Lead", "Product Manager", "Owner",
];
const FIRST_NAMES = ["Ava", "Ben", "Cara", "Dan", "Ella", "Finn", "Gia", "Hugo", "Ivy", "Jae"];
const LAST_NAMES = ["Ashford", "Brooks", "Calder", "Devlin", "Ellis", "Fenn", "Grady", "Holt", "Iverson", "Janssen"];

const pad = (n, w = 5) => String(n).padStart(w, "0");
function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }

// -------------------------------------------------------------------------
// 1) COMPANIES — insert first, keep the returned ids to link people to them.
// -------------------------------------------------------------------------
function buildCompany(i) {
  const country = COUNTRIES[i % COUNTRIES.length];
  const industry = INDUSTRIES[Math.floor(i / 50) % INDUSTRIES.length];
  const source = SOURCES[i % SOURCES.length];
  const niche = NICHES[i % NICHES.length];
  const emp = EMP_COUNTS[i % EMP_COUNTS.length];
  const slug = `qa-co-${pad(i + 1, 4)}`;
  return {
    company_name: `QA Company ${pad(i + 1, 4)}`,
    brand_name: `QA Brand ${pad(i + 1, 4)}`,
    domain: `${slug}.${EMAIL_DOMAIN}`,
    website_url: `https://${slug}.${EMAIL_DOMAIN}`,
    linkedin_url: `https://www.linkedin.com/company/${slug}`,
    industry,
    industry_id: industry, // canonical key == lowercased industry here
    employee_count: emp,
    city: country.city,
    state: country.state,
    country: country.raw,
    country_id: country.id,
    phone: `+1512555${pad(i, 4)}`,
    phone_type: PHONE_TYPES[i % PHONE_TYPES.length],
    email: `hello@${slug}.${EMAIL_DOMAIN}`,
    email_status: EMAIL_STATUSES[i % EMAIL_STATUSES.length],
    quality_tier: ["A", "B", "C"][i % 3],
    source: `${SEED_TAG} & ${source}`,
    source_tokens: [SEED_TAG, source],
    client: "claude-qa",
    niche,
    tags: SEED_TAGS,
    last_updated: NOW,
  };
}

async function seedCompanies() {
  const rows = Array.from({ length: COMPANY_TOTAL }, (_, i) => buildCompany(i));
  const companies = [];
  for (const [bi, batch] of chunk(rows, BATCH).entries()) {
    const { data, error } = await admin
      .from("companies")
      .insert(batch)
      .select("id,company_name,domain,linkedin_url,industry_id,employee_count,country_id,niche");
    if (error) { console.error("company batch", bi, "failed:", error); throw error; }
    companies.push(...data);
    console.log(`  companies inserted: ${companies.length}/${COMPANY_TOTAL}`);
  }
  return companies;
}

// -------------------------------------------------------------------------
// 2) PEOPLE — each dimension varied independently for clean single-filter
//    slices. Linked round-robin to the seed companies (20 people each) so the
//    Companies-triggered EmailBison push (which resolves companies -> linked
//    people) also has data. Person canonical columns are set from the person's
//    OWN varied dimensions (not the linked company's) so the People-page facets
//    stay evenly distributed; company_name/domain/company_linkedin_url mirror
//    the linked company. (This person/company canonical mismatch is cosmetic
//    and only matters if someone later runs a company-update import.)
// -------------------------------------------------------------------------
function buildPerson(i, company) {
  const country = COUNTRIES[i % COUNTRIES.length];
  const industry = INDUSTRIES[Math.floor(i / 1000) % INDUSTRIES.length];
  const source = SOURCES[i % SOURCES.length];
  const niche = NICHES[i % NICHES.length];
  const emp = EMP_COUNTS[i % EMP_COUNTS.length];
  const first = FIRST_NAMES[i % FIRST_NAMES.length];
  const last = LAST_NAMES[Math.floor(i / 1000) % LAST_NAMES.length];
  const n = pad(i + 1);
  const slug = `person${n}`;
  return {
    company_id: company?.id ?? null,
    first_name: first,
    last_name: last,
    full_name: `${first} ${last} ${n}`,
    email: `${slug}@${EMAIL_DOMAIN}`,
    phone: `+1512777${n}`,
    job_title: JOB_TITLES[i % JOB_TITLES.length],
    linkedin_url: `https://www.linkedin.com/in/${slug}`,
    linkedin_username: slug,
    city: country.city,
    state: country.state,
    country: country.raw,
    country_id: country.id,
    company_name: company?.company_name ?? `QA Company ${n}`,
    domain: company?.domain ?? `${slug}.${EMAIL_DOMAIN}`,
    company_linkedin_url: company?.linkedin_url ?? null,
    industry_id: industry,
    employee_count: emp,
    email_status: EMAIL_STATUSES[i % EMAIL_STATUSES.length],
    phone_type: PHONE_TYPES[i % PHONE_TYPES.length],
    source: `${SEED_TAG} & ${source}`,
    source_tokens: [SEED_TAG, source],
    niche_tokens: [niche],
    tags: SEED_TAGS,
    last_updated: NOW,
  };
}

async function seedPeople(companies) {
  let inserted = 0;
  for (let start = 0; start < PEOPLE_TOTAL; start += BATCH) {
    const batch = [];
    for (let i = start; i < Math.min(start + BATCH, PEOPLE_TOTAL); i++) {
      const company = companies.length ? companies[i % companies.length] : null;
      batch.push(buildPerson(i, company));
    }
    const { error } = await admin.from("people").insert(batch);
    if (error) { console.error("people batch @", start, "failed:", error); throw error; }
    inserted += batch.length;
    console.log(`  people inserted: ${inserted}/${PEOPLE_TOTAL}`);
  }
  return inserted;
}

async function main() {
  console.log(`Seeding ${COMPANY_TOTAL} companies + ${PEOPLE_TOTAL} people (marker "${SEED_TAG}")...`);
  const companies = await seedCompanies();
  const people = await seedPeople(companies);
  console.log(`\nDONE. companies=${companies.length} people=${people}`);
  console.log(`Cleanup later with:  node .scratch/seed-qa-people.mjs --cleanup`);
}

async function cleanup() {
  console.log(`Deleting all rows tagged "${SEED_TAG}"...`);
  const p = await admin.from("people").delete().contains("source_tokens", [SEED_TAG]).select("id");
  if (p.error) throw p.error;
  const c = await admin.from("companies").delete().contains("source_tokens", [SEED_TAG]).select("id");
  if (c.error) throw c.error;
  console.log(`Deleted people=${p.data.length} companies=${c.data.length}`);
}

if (process.argv.includes("--cleanup")) {
  cleanup().catch((e) => { console.error(e); process.exit(1); });
} else {
  main().catch((e) => { console.error(e); process.exit(1); });
}
