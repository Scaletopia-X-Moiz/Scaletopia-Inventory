import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function countNonNull(table, column) {
  const { count, error } = await supabase
    .from(table)
    .select("id", { count: "exact", head: true })
    .not(column, "is", null);
  if (error) {
    console.log(`${table}.${column}: ERROR ${error.message}`);
    return;
  }
  console.log(`${table}.${column}: ${count} non-null`);
}

const peopleCols = [
  "source_id",
  "email_verified_at",
  "phone_verified_at",
  "linkedin_username",
];
const companyCols = [
  "description",
  "founded_year",
  "revenue",
  "security_gateway",
  "keywords",
  "technologies",
  "email_verified_at",
  "phone_status",
  "phone_verified_at",
  "client",
  "domain_status",
  "mx_provider",
  "niche",
];

for (const c of peopleCols) await countNonNull("people", c);
console.log("---");
for (const c of companyCols) await countNonNull("companies", c);

const { count: totalPeople } = await supabase.from("people").select("id", { count: "exact", head: true });
const { count: totalCompanies } = await supabase.from("companies").select("id", { count: "exact", head: true });
console.log(`\nTotal people: ${totalPeople}, Total companies: ${totalCompanies}`);
