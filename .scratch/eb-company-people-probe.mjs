import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

// 1) How many companies total?
const { count: companyCount } = await admin
  .from("companies")
  .select("id", { count: "exact", head: true });
console.log("companies total:", companyCount);

// 2) Grab a sample of company ids
const { data: sampleCompanies, error: e1 } = await admin
  .from("companies")
  .select("id, company_name")
  .limit(50);
if (e1) throw e1;
console.log("sample companies fetched:", sampleCompanies.length);
const companyIds = sampleCompanies.map((c) => c.id);

// 3) People linked to those companies via company_id
const { data: peopleByCompany, error: e2 } = await admin
  .from("people")
  .select("id, full_name, company_id, email")
  .in("company_id", companyIds)
  .limit(20);
if (e2) throw e2;
console.log("people linked to those 50 companies (company_id in):", peopleByCompany.length);
if (peopleByCompany.length) console.log("  sample:", JSON.stringify(peopleByCompany[0]));

// 4) How many people have a non-null company_id at all?
const { count: peopleWithCompanyId } = await admin
  .from("people")
  .select("id", { count: "exact", head: true })
  .not("company_id", "is", null);
const { count: peopleTotal } = await admin
  .from("people")
  .select("id", { count: "exact", head: true });
console.log("people total:", peopleTotal, "| with company_id:", peopleWithCompanyId);

// 5) Test the FULL_ROW_COLUMNS embedded join used by the push path
const { data: joinTest, error: e3 } = await admin
  .from("people")
  .select("*, companies(brand_name)")
  .in("company_id", companyIds)
  .limit(5);
console.log("embedded-join query error:", e3?.message ?? "none", "| rows:", joinTest?.length ?? 0);
