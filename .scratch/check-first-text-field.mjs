import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { count: totalCount } = await supabase.from("companies").select("id", { count: "exact", head: true });
console.log("total companies", totalCount);

const { data, error } = await supabase.rpc("company_enrichment_fields", {
  filters: {
    search: null, employeeMin: null, employeeMax: null, employeeBucketRanges: [],
    email: "any", phone: "any",
    niche: { include: [], exclude: [] }, source: { include: [], exclude: [] },
    industry: { include: [], exclude: [] }, country: { include: [], exclude: [] },
    emailStatus: { include: [], exclude: [] }, phoneType: { include: [], exclude: [] },
    virtualFilters: [],
  },
  sample_size: 2000,
  max_values_per_key: 25,
});
if (error) { console.error(error); process.exit(1); }
const field = data.fields.find((f) => f.type === "Text");
console.log("first text field", field.key);

const { count } = await supabase
  .from("companies")
  .select("id", { count: "exact", head: true })
  .not(`custom_data->>${field.key}`, "is", null)
  .neq(`custom_data->>${field.key}`, "");
console.log("is_not_empty count (approx)", count);
