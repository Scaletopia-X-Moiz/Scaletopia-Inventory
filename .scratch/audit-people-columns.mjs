import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function dumpColumns(table) {
  const { data, error } = await supabase.from(table).select("*").limit(1);
  if (error) {
    console.error(`Error querying ${table}:`, error);
    return;
  }
  const row = data?.[0];
  if (!row) {
    console.log(`${table}: no rows returned`);
    return;
  }
  console.log(`\n=== ${table} columns (${Object.keys(row).length}) ===`);
  for (const [key, value] of Object.entries(row)) {
    const type = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
    console.log(`  ${key}: ${type}`);
  }
}

await dumpColumns("people");
await dumpColumns("companies");
