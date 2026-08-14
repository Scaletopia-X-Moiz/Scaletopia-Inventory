import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// The QA seed data left several new fields all-null in a 25-row sample.
// Check the WHOLE companies table (not just QA rows) for a non-null count on
// each, to tell "seed just didn't populate it" apart from "dead column no one
// ever fills in".
const FIELDS = [
  "phone_status",
  "description",
  "email_verified_at",
  "founded_year",
  "keywords",
  "phone_verified_at",
  "revenue",
  "security_gateway",
  "technologies",
];

for (const f of FIELDS) {
  const { count, error } = await admin
    .from("companies")
    .select("id", { count: "exact", head: true })
    .not(f, "is", null);
  if (error) {
    console.log(f, "ERROR", error.message);
    continue;
  }
  console.log(f.padEnd(20), "-> non-null count (whole table):", count);
}

const { count: total } = await admin.from("companies").select("id", { count: "exact", head: true });
console.log("\nTotal companies rows:", total);

// Grab one concrete non-null example row for each field, if any exist.
for (const f of FIELDS) {
  const { data } = await admin.from("companies").select(`id, company_name, ${f}`).not(f, "is", null).limit(1);
  if (data && data.length) {
    console.log(`\nExample non-null ${f}:`, JSON.stringify(data[0]));
  }
}
