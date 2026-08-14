import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// 1. Ground-truth column list for companies (and people, for cross-reference).
for (const table of ["companies", "people"]) {
  const r = await admin.from(table).select("*").limit(1);
  if (r.error) {
    console.log(table, "ERROR:", r.error);
    continue;
  }
  const cols = Object.keys(r.data[0] ?? {}).sort();
  console.log(`\n=== ${table} (${cols.length} columns) ===`);
  console.log(cols.join(", "));
}

// 2. Sample a QA-tagged company row with non-null values in most columns, to
// see realistic values (not just column names).
const qa = await admin
  .from("companies")
  .select("*")
  .contains("source_tokens", ["claude-qa-2026-08"])
  .limit(1)
  .maybeSingle();
console.log("\n=== sample QA company row ===");
console.log(JSON.stringify(qa.data, null, 2));
