import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

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
const r = await admin.rpc("companies_matching_virtual_filters", { filters: payload }).range(0, 4);
const ids = (r.data ?? []).map((x) => x.id);
const { data } = await admin.from("companies").select("id, company_name, email, phone, domain, first_name, last_name").in("id", ids);
console.log("company columns present:", Object.keys(data?.[0] ?? {}));
for (const c of data ?? []) console.log(JSON.stringify(c));

// how many of ALL matched have a non-empty company.email?
let withEmail = 0, totalChecked = 0;
const first = await admin.rpc("companies_matching_virtual_filters", { filters: payload }, { count: "exact" }).range(0, 999);
const allIds = (first.data ?? []).map((x) => x.id);
function chunk(a, n){const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o;}
for (const c of chunk(allIds, 200)) {
  const { data: rows } = await admin.from("companies").select("email").in("id", c);
  for (const row of rows ?? []) { totalChecked++; if (row.email && row.email.trim() !== "") withEmail++; }
}
console.log(`\nof ${totalChecked} matched companies (first 1000): with non-empty company.email = ${withEmail}`);
