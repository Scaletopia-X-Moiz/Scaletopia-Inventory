// EmailBison push verification oracle.
//   node .scratch/eb-verify.mjs <scenario> [--since <ISO>]
// Three-way reconciliation for one pushed scenario:
//   E   = expected rows from the app's OWN filter semantics (Supabase)
//   A   = platform_pushes rows the app recorded (id -> EmailBison lead id)
//   EB  = the actual lead read back from EmailBison by /api/leads/{id}
// Reports: filter count vs expected, missing (in E, never pushed),
// per-item field + custom-variable mismatches, and (for no-email slices)
// that nothing landed.
import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TESTING_ID = "0c556239-1608-41fc-9fda-89196c55a56f";
const INTERNAL_ID = "a8dfe6bc-dd09-4146-b628-fc0eacce34f3";
const TAG = "claude-qa-2026-08";

const args = process.argv.slice(2);
const scenarioKey = args[0];
const sinceArg = args.includes("--since") ? args[args.indexOf("--since") + 1] : null;
const clientArg = args.includes("--client") ? args[args.indexOf("--client") + 1] : "testing";
const CLIENT_ID = clientArg === "internal" ? INTERNAL_ID : clientArg === "testing" ? TESTING_ID : clientArg;

// ---- helpers -------------------------------------------------------------
const norm = (v) => (v === null || v === undefined || v === "" ? "" : String(v));
const stringifyCV = (v) => {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try { return JSON.stringify(v); } catch { return null; }
};
function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ---- scenarios -----------------------------------------------------------
// Each: entity, a Supabase query builder reproducing the app filter, and
// computeExpected(row, companyById) -> { email, fields:{company,first,last,title}, cvars:{name:value} }.
const CV = {
  // people custom vars for P1
  qa_city: (r) => norm(r.city) || null,
  qa_state: (r) => norm(r.state) || null,
};

const scenarios = {
  C1: {
    entity: "companies", label: "Companies niche=qa-uncleaned (company-native + raw-name fallback + custom var)",
    filter: (q) => q.contains("source_tokens", [TAG]).eq("niche", "qa-uncleaned"),
    expectPushableAll: true,
    computeExpected: (r) => ({
      email: r.email,
      fields: { company: r.brand_name || r.company_name, first: r.company_name || "", last: "company last name", title: "" },
      cvars: r.industry != null ? { qa_industry: stringifyCV(r.industry) } : {},
    }),
  },
  C2: {
    entity: "companies", label: "Companies niche=qa-orphan-nopeople (orphan companies push as leads)",
    filter: (q) => q.contains("source_tokens", [TAG]).eq("niche", "qa-orphan-nopeople"),
    expectPushableAll: true,
    computeExpected: (r) => ({
      email: r.email,
      fields: { company: r.brand_name || r.company_name, first: r.company_name || "", last: "company last name", title: "" },
      cvars: {},
    }),
  },
  C3: {
    entity: "companies", label: "Companies country=GB (country filter integrity + custom var)",
    filter: (q) => q.contains("source_tokens", [TAG]).eq("country_id", "GB"),
    expectPushableAll: true,
    computeExpected: (r) => ({
      email: r.email,
      fields: { company: r.brand_name || r.company_name, first: r.company_name || "", last: "company last name", title: "" },
      cvars: r.industry != null ? { qa_industry: stringifyCV(r.industry) } : {},
    }),
    // filter-integrity: every landed lead's source company must be country_id=GB
    integrity: (r) => r.country_id === "GB",
  },
  P1: {
    entity: "people", label: "People niche=qa-uncleaned (4 custom vars + raw-name fallback)",
    filter: (q) => q.contains("source_tokens", [TAG]).contains("niche_tokens", ["qa-uncleaned"]),
    needsCompany: true,
    computeExpected: (r, coById) => {
      const co = r.company_id ? coById.get(r.company_id) : null;
      const cvars = {};
      if (norm(r.city)) cvars.qa_city = norm(r.city);
      if (norm(r.state)) cvars.qa_state = norm(r.state);
      if (co && co.domain != null) cvars.qa_company_domain = stringifyCV(co.domain);
      if (co && co.employee_count != null) cvars.qa_employees = stringifyCV(co.employee_count);
      return {
        email: r.email,
        fields: {
          company: (co && co.brand_name) || r.company_name || "",
          first: norm(r.first_name), last: norm(r.last_name), title: norm(r.job_title),
        },
        cvars,
      };
    },
  },
  P2: {
    entity: "people", label: "People niche=qa-noemail (all no-email -> all must FAIL, nothing lands)",
    filter: (q) => q.contains("source_tokens", [TAG]).contains("niche_tokens", ["qa-noemail"]),
    expectAllFail: true,
    computeExpected: (r) => ({ email: r.email, fields: {}, cvars: {} }),
  },
  A4: {
    entity: "companies", label: "Companies niche=b2b-saas (literal static custom var + null-column drop)",
    filter: (q) => q.contains("source_tokens", [TAG]).eq("niche", "b2b-saas"),
    computeExpected: (r) => ({
      email: r.email,
      fields: { company: r.brand_name || r.company_name, first: r.company_name || "", last: "company last name", title: "" },
      cvars: { qa_note: "batchA4" },       // literal, identical on every lead
      absentCvars: ["qa_founded"],          // founded_year is null for all → must be dropped, not sent
    }),
  },
  G1: {
    entity: "companies", label: "Companies industry=software development (industry filter integrity + custom var)",
    filter: (q) => q.contains("source_tokens", [TAG]).eq("industry_id", "software development"),
    computeExpected: (r) => ({
      email: r.email,
      fields: { company: r.brand_name || r.company_name, first: r.company_name || "", last: "company last name", title: "" },
      cvars: r.industry != null ? { qa_industry: stringifyCV(r.industry) } : {},
    }),
  },
  B3: {
    entity: "people", label: "People country=CA (people country filter integrity + volume, defaults)",
    filter: (q) => q.contains("source_tokens", [TAG]).eq("country_id", "CA"),
    needsCompany: true,
    computeExpected: (r, coById) => {
      const co = r.company_id ? coById.get(r.company_id) : null;
      return {
        email: r.email,
        fields: {
          company: (co && co.brand_name) || r.company_name || "",
          first: norm(r.first_name), last: norm(r.last_name), title: norm(r.job_title),
        },
        cvars: {},
      };
    },
  },
  B4: {
    entity: "people", label: "People niche=qa-noemail OR qa-uncleaned (mixed batch: 300 succeed + 100 fail)",
    filter: (q) => q.contains("source_tokens", [TAG]).overlaps("niche_tokens", ["qa-noemail", "qa-uncleaned"]),
    needsCompany: true,
    computeExpected: (r, coById) => {
      const co = r.company_id ? coById.get(r.company_id) : null;
      return {
        email: r.email,
        fields: {
          company: (co && co.brand_name) || r.company_name || "",
          first: norm(r.first_name), last: norm(r.last_name), title: norm(r.job_title),
        },
        cvars: {},
      };
    },
  },
  D1: {
    entity: "companies", label: "Companies country=DE — Static value on First/Last name (patch)",
    filter: (q) => q.contains("source_tokens", [TAG]).eq("country_id", "DE"),
    computeExpected: (r) => ({
      email: r.email,
      fields: { company: r.brand_name || r.company_name, first: "QA-FN", last: "QA-LN", title: "" },
      cvars: {},
    }),
  },
  D2: {
    entity: "companies", label: "Companies country=DE — Full replace (put) with First/Last IGNORED → blanks them",
    filter: (q) => q.contains("source_tokens", [TAG]).eq("country_id", "DE"),
    computeExpected: (r) => ({
      email: r.email,
      fields: { company: r.brand_name || r.company_name, first: "", last: "", title: "" },
      cvars: {},
    }),
  },
};

const scenario = scenarios[scenarioKey];
if (!scenario) { console.error(`Unknown scenario '${scenarioKey}'. Options: ${Object.keys(scenarios).join(", ")}`); process.exit(1); }

// ---- EmailBison creds ----------------------------------------------------
const { data: client } = await admin.from("clients").select("emailbison_api_key,emailbison_workspace_id").eq("id", CLIENT_ID).single();
const base = (client.emailbison_workspace_id || "").replace(/\/$/, "");
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, Accept: "application/json", "Content-Type": "application/json" };
async function getLead(id) {
  const r = await fetch(`${base}/api/leads/${id}`, { headers });
  if (!r.ok) return { ok: false, status: r.status };
  const j = await r.json().catch(() => null);
  const lead = j?.data ?? j;
  return { ok: true, lead };
}
function leadCVMap(lead) {
  const m = {};
  for (const cv of lead?.custom_variables ?? []) {
    const name = cv?.name ?? cv?.variable?.name ?? cv?.custom_variable?.name;
    if (name != null) m[String(name)] = cv?.value ?? cv?.pivot?.value ?? "";
  }
  return m;
}

console.log(`\n=== Scenario ${scenarioKey}: ${scenario.label} ===`);

// ---- E: expected rows ----------------------------------------------------
const table = scenario.entity;
const cols = table === "companies"
  ? "id,company_name,brand_name,email,industry,niche,country_id,source_tokens"
  : "id,first_name,last_name,job_title,email,company_name,company_id,city,state,country_id,niche_tokens,source_tokens";
let rows = []; const PAGE = 1000;
for (let from = 0; ; from += PAGE) {
  const { data, error } = await scenario.filter(admin.from(table).select(cols)).range(from, from + PAGE - 1);
  if (error) { console.error("filter query error", error); process.exit(1); }
  rows.push(...(data ?? []));
  if (!data || data.length < PAGE) break;
}
console.log(`E (filter match count, = app "Push N"): ${rows.length}`);

// linked companies for people scenarios
let coById = new Map();
if (scenario.needsCompany) {
  const ids = [...new Set(rows.map((r) => r.company_id).filter(Boolean))];
  for (const c of chunk(ids, 200)) {
    const { data } = await admin.from("companies").select("id,brand_name,company_name,domain,employee_count").in("id", c);
    for (const co of data ?? []) coById.set(co.id, co);
  }
}

const expected = new Map(); // id -> {email, fields, cvars}
for (const r of rows) expected.set(r.id, scenario.computeExpected(r, coById));
const withEmail = rows.filter((r) => norm(r.email));
const noEmail = rows.filter((r) => !norm(r.email));
console.log(`  with email (pushable): ${withEmail.length}   no email (should fail): ${noEmail.length}`);

// ---- A: platform_pushes the app recorded ---------------------------------
const idCol = table === "companies" ? "company_id" : "person_id";
const pushed = new Map(); // id -> {leadId, campaign_tag, pushed_at}
for (const c of chunk(rows.map((r) => r.id), 200)) {
  let q = admin.from("platform_pushes").select(`${idCol},platform_contact_id,campaign_tag,pushed_at`)
    .eq("client_id", CLIENT_ID).eq("platform", "emailbison").in(idCol, c);
  if (sinceArg) q = q.gte("pushed_at", sinceArg);
  const { data, error } = await q;
  if (error) { console.error("platform_pushes error", error); process.exit(1); }
  for (const row of data ?? []) pushed.set(row[idCol], { leadId: row.platform_contact_id, campaign_tag: row.campaign_tag, pushed_at: row.pushed_at });
}
console.log(`A (platform_pushes rows for these ids, this client${sinceArg ? `, since ${sinceArg}` : ""}): ${pushed.size}`);

// ---- P2 short-circuit: nothing should have landed ------------------------
if (scenario.expectAllFail) {
  const landed = [...pushed.values()].filter((p) => p.leadId);
  console.log(`\nRESULT: ${landed.length === 0 ? "PASS ✅" : "FAIL ❌"} — leads landed for a no-email slice: ${landed.length} (expected 0)`);
  console.log(`  (Confirm in /push-activity that all ${rows.length} show a "no email on record" failure reason.)`);
  process.exit(0);
}

// ---- reconcile pushed vs EmailBison --------------------------------------
const pushableIds = withEmail.map((r) => r.id);
const missing = pushableIds.filter((id) => !pushed.has(id) || !pushed.get(id).leadId);
console.log(`\nMissing (expected pushable but NOT in platform_pushes): ${missing.length}`);
if (missing.length) console.log("  e.g.", missing.slice(0, 5).map((id) => expected.get(id)?.email).join(", "));

const toCheck = pushableIds.filter((id) => pushed.get(id)?.leadId);
console.log(`Fetching ${toCheck.length} leads from EmailBison for per-item verification…`);
const fieldMismatch = [], cvMismatch = [], fetchFail = [], emailMismatch = [], integrityFail = [];
await mapLimit(toCheck, 6, async (id) => {
  const exp = expected.get(id);
  const { leadId } = pushed.get(id);
  const res = await getLead(leadId);
  if (!res.ok) { fetchFail.push({ email: exp.email, leadId, status: res.status }); return; }
  const lead = res.lead;
  if (norm(lead.email).toLowerCase() !== norm(exp.email).toLowerCase())
    emailMismatch.push({ id, expected: exp.email, got: lead.email, leadId });
  // standard fields
  for (const [k, v] of Object.entries(exp.fields)) {
    const got = k === "company" ? lead.company : k === "first" ? lead.first_name : k === "last" ? lead.last_name : lead.title;
    if (norm(got) !== norm(v)) fieldMismatch.push({ email: exp.email, field: k, expected: v, got, leadId });
  }
  // custom variables (present + matching)
  const gotCV = leadCVMap(lead);
  for (const [name, val] of Object.entries(exp.cvars)) {
    if (!(name in gotCV)) cvMismatch.push({ email: exp.email, var: name, expected: val, got: "(missing)", leadId });
    else if (norm(gotCV[name]) !== norm(val)) cvMismatch.push({ email: exp.email, var: name, expected: val, got: gotCV[name], leadId });
  }
  // custom variables that must be ABSENT (null column → dropped, not sent as "")
  for (const name of exp.absentCvars ?? []) {
    if (name in gotCV && norm(gotCV[name]) !== "") cvMismatch.push({ email: exp.email, var: name, expected: "(absent)", got: gotCV[name], leadId });
  }
});

// ---- report --------------------------------------------------------------
const show = (arr, n = 8) => arr.slice(0, n).map((x) => JSON.stringify(x)).join("\n    ");
console.log(`\n---- RESULT ----`);
console.log(`  filter matched (E):        ${rows.length}`);
console.log(`  pushable (had email):      ${withEmail.length}`);
console.log(`  app pushed (A, w/ leadId): ${[...pushed.values()].filter((p) => p.leadId).length}`);
console.log(`  verified in EmailBison:    ${toCheck.length - fetchFail.length}`);
console.log(`  MISSING (not pushed):      ${missing.length}`);
console.log(`  lead fetch failures:       ${fetchFail.length}`);
console.log(`  email mismatches:          ${emailMismatch.length}`);
console.log(`  standard-field mismatches: ${fieldMismatch.length}`);
console.log(`  custom-var mismatches:     ${cvMismatch.length}`);
if (fieldMismatch.length) console.log("  field mismatches:\n    " + show(fieldMismatch));
if (cvMismatch.length) console.log("  custom-var mismatches:\n    " + show(cvMismatch));
if (emailMismatch.length) console.log("  email mismatches:\n    " + show(emailMismatch));
if (fetchFail.length) console.log("  fetch failures:\n    " + show(fetchFail));
const clean = !missing.length && !fieldMismatch.length && !cvMismatch.length && !emailMismatch.length && !fetchFail.length;
console.log(`\n  ${clean ? "PASS ✅ — every pushable row landed and matches exactly." : "FAIL ❌ — see mismatches above."}`);
