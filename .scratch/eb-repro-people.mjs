import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const payload = {
  search: null, employeeMin: null, employeeMax: null, employeeBucketRanges: [],
  email: "not_empty", phone: "any",
  niche: { include: [], exclude: [] }, source: { include: [], exclude: [] },
  industry: { include: [], exclude: [] }, country: { include: [], exclude: [] },
  emailStatus: { include: [], exclude: [] }, phoneType: { include: [], exclude: [] },
  virtualFilters: { combinator: "and", groups: [{ combinator: "and", conditions: [
    { key: "testEnrichment1", type: "text", value: ["test1", "test2"], operator: "is" },
    { key: "testEnrichment2", type: "text", value: ["test6"], operator: "is" },
  ] }] },
  pushStatus: null,
};

// Resolve all matched company ids (paged)
const PAGE = 1000;
let all = [];
const first = await admin.rpc("companies_matching_virtual_filters", { filters: payload }, { count: "exact" }).range(0, PAGE - 1);
all = (first.data ?? []).map((r) => r.id);
const total = first.count ?? all.length;
for (let start = PAGE; start < total; start += PAGE) {
  const p = await admin.rpc("companies_matching_virtual_filters", { filters: payload }).range(start, start + PAGE - 1);
  all.push(...(p.data ?? []).map((r) => r.id));
}
console.log("matched companies:", all.length);

// Count people linked to these companies (chunked)
function chunk(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
let peopleCount = 0;
let sample = null;
for (const c of chunk(all, 200)) {
  const { data, error } = await admin.from("people").select("id, full_name, company_id, email").in("company_id", c);
  if (error) throw error;
  peopleCount += data.length;
  if (!sample && data.length) sample = data[0];
}
console.log("people linked to matched companies:", peopleCount);
console.log("sample person:", JSON.stringify(sample));

// Cross-check: do the test-enrichment companies overlap with companies that have people at all?
const { data: peopleCompanyIds } = await admin.from("people").select("company_id").not("company_id", "is", null).limit(14000);
const peopleCompanySet = new Set((peopleCompanyIds ?? []).map((r) => r.company_id));
const overlap = all.filter((id) => peopleCompanySet.has(id)).length;
console.log("matched companies that have >=1 linked person:", overlap, "of", all.length);
