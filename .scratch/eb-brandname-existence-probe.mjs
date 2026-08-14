import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

function time(label, promise) {
  const t0 = performance.now();
  return promise.then((res) => {
    const ms = (performance.now() - t0).toFixed(1);
    console.log(`\n=== ${label} (${ms}ms) ===`);
    return res;
  });
}

// ---- PEOPLE PATH: existence query ----
// brand_name present in the whole people set ⇔ this returns >=1 row.
const peopleExists = await time(
  "PEOPLE existence: people w/ linked company brand_name (no filters)",
  admin
    .from("people")
    .select("id, companies!inner(brand_name)")
    .not("companies.brand_name", "is", null)
    .limit(1)
);
console.log("error:", peopleExists.error?.message ?? "none");
console.log("rows:", peopleExists.data?.length ?? 0);
console.log("sample:", JSON.stringify(peopleExists.data?.[0] ?? null));

// Control: how many people actually have a brand_name (bounded count) to sanity check
const peopleCount = await time(
  "PEOPLE control: count people w/ brand_name (head)",
  admin
    .from("people")
    .select("id, companies!inner(brand_name)", { count: "exact", head: true })
    .not("companies.brand_name", "is", null)
);
console.log("error:", peopleCount.error?.message ?? "none");
console.log("count:", peopleCount.count);

// ---- COMPANIES PATH: existence query ----
// A filtered company that has >=1 linked person AND a non-null brand_name.
const companiesExists = await time(
  "COMPANIES existence: company w/ linked person AND brand_name (no filters)",
  admin
    .from("companies")
    .select("id, brand_name, people!inner(id)")
    .not("brand_name", "is", null)
    .limit(1)
);
console.log("error:", companiesExists.error?.message ?? "none");
console.log("rows:", companiesExists.data?.length ?? 0);
console.log("sample:", JSON.stringify(companiesExists.data?.[0] ?? null));

const companiesCount = await time(
  "COMPANIES control: count companies w/ person AND brand_name (head)",
  admin
    .from("companies")
    .select("id, people!inner(id)", { count: "exact", head: true })
    .not("brand_name", "is", null)
);
console.log("error:", companiesCount.error?.message ?? "none");
console.log("count:", companiesCount.count);

// ---- NEGATIVE control: a filter matching a company set with no brand_name ----
// Use an impossible-ish domain filter to prove the query returns 0 rows cleanly.
const negative = await time(
  "COMPANIES negative: brand_name set but bogus domain filter → expect 0",
  admin
    .from("companies")
    .select("id, brand_name, people!inner(id)")
    .not("brand_name", "is", null)
    .ilike("domain", "%__no_such_domain_zzz__%")
    .limit(1)
);
console.log("error:", negative.error?.message ?? "none");
console.log("rows:", negative.data?.length ?? 0);

console.log("\nDONE");
