// Issue #144 verification: does a patch re-push preserve custom variables?
//   node .scratch/eb-verify-144.mjs
// Overlap set = people source=claude-qa-2026-08 AND niche=qa-uncleaned WITH email.
// Push A (P1) set 4 custom vars on these; Push B (B4) re-pushed the same people
// in patch mode with NO custom vars. If #144 is fixed, all 4 vars survive.
import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLIENTS = { testing: "0c556239-1608-41fc-9fda-89196c55a56f", internal: "a8dfe6bc-dd09-4146-b628-fc0eacce34f3" };
const TESTING_ID = CLIENTS[process.argv[2] || "internal"] || (process.argv[2] || "");
const TAG = "claude-qa-2026-08";
const EXPECTED_VARS = ["qa_city", "qa_state", "qa_company_domain", "qa_employees"];

const norm = (v) => (v === null || v === undefined || v === "" ? "" : String(v));
function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }));
  return out;
}

// ---- EmailBison creds for Testing ----------------------------------------
const { data: client } = await admin.from("clients").select("emailbison_api_key,emailbison_workspace_id").eq("id", TESTING_ID).single();
const base = (client.emailbison_workspace_id || "").replace(/\/$/, "");
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, Accept: "application/json" };
async function getLead(id) {
  const r = await fetch(`${base}/api/leads/${id}`, { headers });
  if (!r.ok) return { ok: false, status: r.status };
  const j = await r.json().catch(() => null);
  return { ok: true, lead: j?.data ?? j };
}
function leadCVMap(lead) {
  const m = {};
  for (const cv of lead?.custom_variables ?? []) {
    const name = cv?.name ?? cv?.variable?.name ?? cv?.custom_variable?.name;
    if (name != null) m[String(name)] = cv?.value ?? cv?.pivot?.value ?? "";
  }
  return m;
}

// ---- overlap people (Push A ∩ Push B target, with email) -----------------
let rows = []; const PAGE = 1000;
for (let from = 0; ; from += PAGE) {
  const { data, error } = await admin.from("people")
    .select("id,email,city,state")
    .contains("source_tokens", [TAG])
    .overlaps("niche_tokens", ["qa-uncleaned"])
    .range(from, from + PAGE - 1);
  if (error) { console.error("people query error", error); process.exit(1); }
  rows.push(...(data ?? []));
  if (!data || data.length < PAGE) break;
}
const withEmail = rows.filter((r) => norm(r.email));
console.log(`Overlap people (source=${TAG} & niche=qa-uncleaned): ${rows.length}  with email: ${withEmail.length}`);

// ---- lead ids the app recorded for Testing -------------------------------
const leadByPerson = new Map();
for (const c of chunk(withEmail.map((r) => r.id), 200)) {
  const { data } = await admin.from("platform_pushes")
    .select("person_id,platform_contact_id")
    .eq("client_id", TESTING_ID).eq("platform", "emailbison").in("person_id", c);
  for (const row of data ?? []) if (row.platform_contact_id) leadByPerson.set(row.person_id, row.platform_contact_id);
}
console.log(`With a recorded EmailBison lead id: ${leadByPerson.size}`);

// ---- read each lead back, check the 4 vars survived ----------------------
const toCheck = withEmail.filter((r) => leadByPerson.has(r.id));
let allFour = 0, wipedAll = 0, partial = 0, fetchFail = 0;
const examples = { wiped: [], partial: [] };

await mapLimit(toCheck, 8, async (r) => {
  const res = await getLead(leadByPerson.get(r.id));
  if (!res.ok) { fetchFail++; return; }
  const cv = leadCVMap(res.lead);
  const present = EXPECTED_VARS.filter((n) => norm(cv[n]) !== "");
  if (present.length === EXPECTED_VARS.length) allFour++;
  else if (present.length === 0) { wipedAll++; if (examples.wiped.length < 5) examples.wiped.push({ email: r.email, has: Object.keys(cv) }); }
  else { partial++; if (examples.partial.length < 5) examples.partial.push({ email: r.email, present }); }
});

console.log(`\n=== Issue #144 result (checked ${toCheck.length} re-pushed leads) ===`);
console.log(`  all 4 custom vars intact:  ${allFour}`);
console.log(`  ALL vars wiped ([]):       ${wipedAll}   <-- the #144 bug`);
console.log(`  partially wiped:           ${partial}`);
console.log(`  lead fetch failures:       ${fetchFail}`);
if (examples.wiped.length) console.log(`  wiped examples:`, JSON.stringify(examples.wiped));
if (examples.partial.length) console.log(`  partial examples:`, JSON.stringify(examples.partial));

const pass = toCheck.length > 0 && wipedAll === 0 && partial === 0 && allFour === toCheck.length;
console.log(`\n#144 ${pass ? "FIXED ✅  (patch re-push preserved all custom variables)" : "STILL BROKEN ❌  (custom variables lost on re-push)"}`);
process.exit(pass ? 0 : 1);
