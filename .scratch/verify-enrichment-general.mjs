import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Check whether QA-seeded people have any custom_data at all.
const { data: qaSample } = await supabase
  .from("people")
  .select("id, custom_data")
  .overlaps("source_tokens", ["claude-qa-2026-08"])
  .limit(20);
const qaNonEmpty = qaSample.filter((r) => r.custom_data && Object.keys(r.custom_data).length > 0);
console.log(`QA sample: ${qaNonEmpty.length}/${qaSample.length} have non-empty custom_data`);

// Now call the enrichment-fields RPC with NO filters (whole table) to confirm
// the mechanism itself is wired and working against real data.
const noFilters = {
  search: null,
  jobTitle: null,
  employeeMin: null,
  employeeMax: null,
  employeeBucketRanges: [],
  email: "any",
  phone: "any",
  niche: { include: [], exclude: [] },
  source: { include: [], exclude: [] },
  industry: { include: [], exclude: [] },
  country: { include: [], exclude: [] },
  emailStatus: { include: [], exclude: [] },
  phoneType: { include: [], exclude: [] },
  virtualFilters: { combinator: "and", groups: [] },
  pushStatus: null,
};

const { data, error } = await supabase.rpc("person_enrichment_fields", {
  filters: noFilters,
  sample_size: 500,
  max_values_per_key: 25,
});
if (error) {
  console.error("RPC error (unfiltered):", error);
} else {
  console.log("Unfiltered sampledRows:", data.sampledRows);
  console.log("Unfiltered fields count:", data.fields.length);
  console.log("First few fields:", JSON.stringify(data.fields.slice(0, 5), null, 2));
}

// Same check for companies enrichment-fields RPC (GHL dialog also calls a
// people version, but confirm the sibling RPC exists/works too).
const { data: d2, error: e2 } = await supabase.rpc("company_enrichment_fields", {
  filters: {
    search: null,
    industry: { include: [], exclude: [] },
    country: { include: [], exclude: [] },
    niche: { include: [], exclude: [] },
    source: { include: [], exclude: [] },
    qualityTier: { include: [], exclude: [] },
    employeeMin: null,
    employeeMax: null,
    employeeBucketRanges: [],
    virtualFilters: { combinator: "and", groups: [] },
    pushStatus: null,
  },
  sample_size: 500,
  max_values_per_key: 25,
});
if (e2) {
  console.error("company RPC error:", e2);
} else {
  console.log("company sampledRows:", d2.sampledRows, "fields count:", d2.fields.length);
}
