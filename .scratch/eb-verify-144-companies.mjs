// Issue #144 verification — COMPANY side.
//   node .scratch/eb-verify-144-companies.mjs [internal|testing]
// Company-native push (runCompaniesAddToEmailBison) uses the same
// upsertLeadsBulk/toWireLead path as people. Scenario to run on the FIXED,
// deployed app before this check:
//   Push C-A: /companies?source=claude-qa-2026-08&niche=qa-uncleaned
//             custom var qa_industry -> Industry, patch   (sets qa_industry)
//   Push C-B: /companies?source=claude-qa-2026-08&niche=qa-uncleaned
//             NO custom vars, patch                        (must NOT wipe it)
// If #144 is fixed, every company whose `industry` is set keeps qa_industry.
import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLIENTS = { testing: "0c556239-1608-41fc-9fda-89196c55a56f", internal: "a8dfe6bc-dd09-4146-b628-fc0eacce34f3" };
const CLIENT_ID = CLIENTS[process.argv[2] || "internal"] || (process.argv[2] || "");
const TAG = "claude-qa-2026-08";
const NICHE = "qa-uncleaned";

const norm = (v) => (v === null || v === undefined || v === "" ? "" : String(v));
const stringifyCV = (v) => { if (v == null) return null; if (typeof v === "string") return v; if (typeof v === "number" || typeof v === "boolean") return String(v); try { return JSON.stringify(v); } catch { return null; } };
function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
async function mapLimit(items, limit, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => { while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); } })); return out; }

const { data: client } = await admin.from("clients").select("emailbison_api_key,emailbison_workspace_id").eq("id", CLIENT_ID).single();
const base = (client.emailbison_workspace_id || "").replace(/\/$/, "");
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, Accept: "application/json" };
async function getLead(id) { const r = await fetch(`${base}/api/leads/${id}`, { headers }); if (!r.ok) return { ok: false }; const j = await r.json().catch(() => null); return { ok: true, lead: j?.data ?? j }; }
function cvMap(lead) { const m = {}; for (const cv of lead?.custom_variables ?? []) { const n = cv?.name ?? cv?.variable?.name ?? cv?.custom_variable?.name; if (n != null) m[String(n)] = cv?.value ?? cv?.pivot?.value ?? ""; } return m; }

// companies matching the scenario filter
let rows = []; const PAGE = 1000;
for (let from = 0; ; from += PAGE) {
  const { data, error } = await admin.from("companies").select("id,email,industry").contains("source_tokens", [TAG]).eq("niche", NICHE).range(from, from + PAGE - 1);
  if (error) { console.error("companies query error", error); process.exit(1); }
  rows.push(...(data ?? [])); if (!data || data.length < PAGE) break;
}
const withIndustry = rows.filter((r) => r.industry != null); // these SHOULD carry qa_industry
console.log(`Companies (source=${TAG} & niche=${NICHE}): ${rows.length}  with industry set (expect qa_industry): ${withIndustry.length}`);

const leadByCo = new Map();
for (const c of chunk(rows.map((r) => r.id), 200)) {
  const { data } = await admin.from("platform_pushes").select("company_id,platform_contact_id").eq("client_id", CLIENT_ID).eq("platform", "emailbison").in("company_id", c);
  for (const row of data ?? []) if (row.platform_contact_id) leadByCo.set(row.company_id, row.platform_contact_id);
}
console.log(`With a recorded EmailBison lead id: ${leadByCo.size}`);

const toCheck = withIndustry.filter((r) => leadByCo.has(r.id));
let intact = 0, wiped = 0, mismatch = 0, fetchFail = 0; const ex = { wiped: [], mismatch: [] };
await mapLimit(toCheck, 8, async (r) => {
  const res = await getLead(leadByCo.get(r.id)); if (!res.ok) { fetchFail++; return; }
  const cv = cvMap(res.lead); const got = norm(cv.qa_industry); const want = norm(stringifyCV(r.industry));
  if (got === "") { wiped++; if (ex.wiped.length < 5) ex.wiped.push({ email: r.email, has: Object.keys(cv) }); }
  else if (got !== want) { mismatch++; if (ex.mismatch.length < 5) ex.mismatch.push({ email: r.email, want, got }); }
  else intact++;
});

console.log(`\n=== Issue #144 COMPANY result (checked ${toCheck.length} company leads) ===`);
console.log(`  qa_industry intact:   ${intact}`);
console.log(`  qa_industry WIPED:    ${wiped}   <-- the #144 bug`);
console.log(`  value mismatch:       ${mismatch}`);
console.log(`  lead fetch failures:  ${fetchFail}`);
if (ex.wiped.length) console.log(`  wiped examples:`, JSON.stringify(ex.wiped));
if (ex.mismatch.length) console.log(`  mismatch examples:`, JSON.stringify(ex.mismatch));
const pass = toCheck.length > 0 && wiped === 0 && mismatch === 0 && intact === toCheck.length;
console.log(`\n#144 (company side) ${pass ? "FIXED ✅  (patch re-push preserved qa_industry)" : "NOT CONFIRMED ❌  (re-push both company scenarios on the deployed fix first)"}`);
process.exit(pass ? 0 : 1);
