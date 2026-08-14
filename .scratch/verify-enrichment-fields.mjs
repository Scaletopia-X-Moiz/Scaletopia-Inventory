import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Mirrors lib/data/people.ts's toFilterOptionsRpcPayload + lib/data/
// enrichment-fields.ts's getPersonEnrichmentFields, called directly against
// the QA-seeded people (source contains "claude-qa-2026-08") to confirm the
// enrichment-fields RPC actually returns fields for this filtered set (not
// silently broken).
const filters = {
  search: null,
  jobTitle: null,
  employeeMin: null,
  employeeMax: null,
  employeeBucketRanges: [],
  email: "any",
  phone: "any",
  niche: { include: [], exclude: [] },
  source: { include: ["claude-qa-2026-08"], exclude: [] },
  industry: { include: [], exclude: [] },
  country: { include: [], exclude: [] },
  emailStatus: { include: [], exclude: [] },
  phoneType: { include: [], exclude: [] },
  virtualFilters: { combinator: "and", groups: [] },
  pushStatus: null,
};

const { data, error } = await supabase.rpc("person_enrichment_fields", {
  filters,
  sample_size: 500,
  max_values_per_key: 25,
});

if (error) {
  console.error("RPC error:", error);
  process.exit(1);
}

console.log("sampledRows:", data.sampledRows);
console.log("fields:", JSON.stringify(data.fields, null, 2));
