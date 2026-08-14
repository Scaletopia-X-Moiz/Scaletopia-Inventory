import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const admin = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const PAGE = 1000;
async function fetchAll(table, cols, build = (q) => q) {
  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await build(admin.from(table).select(cols)).range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return rows;
}
function chunk(a, n) {
  const out = [];
  for (let i = 0; i < a.length; i += n) out.push(a.slice(i, i + n));
  return out;
}

// ---------- OLD companies path (no filter): all company ids -> all linked people narrow rows ----------
let t0 = performance.now();
const companies = await fetchAll("companies", "id,brand_name");
const companyIds = companies.map((c) => c.id);
let peopleRows = [];
const chunks = chunk(companyIds, 200);
for (let i = 0; i < chunks.length; i += 10) {
  const window = chunks.slice(i, i + 10);
  const res = await Promise.all(
    window.map((c) =>
      fetchAll("people", "id, company_name, companies(brand_name)", (q) => q.in("company_id", c))
    )
  );
  peopleRows.push(...res.flat());
}
const oldMs = (performance.now() - t0).toFixed(0);
const oldHasBrand = peopleRows.some((r) => !!r.companies?.brand_name);
console.log(
  `OLD companies path: ${oldMs}ms | companies=${companyIds.length} peopleRows=${peopleRows.length} hasBrand=${oldHasBrand}`
);

// ---------- NEW companies path: single existence query ----------
t0 = performance.now();
const { data, error } = await admin
  .from("companies")
  .select("id, people!inner(id)")
  .not("brand_name", "is", null)
  .limit(1);
if (error) throw error;
const newMs = (performance.now() - t0).toFixed(0);
console.log(`NEW companies path: ${newMs}ms | hasBrand=${(data?.length ?? 0) > 0}`);
console.log(`\nSpeedup: ${(oldMs / newMs).toFixed(1)}x`);
