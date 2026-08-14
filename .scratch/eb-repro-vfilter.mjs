import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// Payload as toFilterOptionsRpcPayload would build it for the failing job.
const payload = {
  search: null,
  employeeMin: null,
  employeeMax: null,
  employeeBucketRanges: [],
  email: "not_empty",
  phone: "any",
  niche: { include: [], exclude: [] },
  source: { include: [], exclude: [] },
  industry: { include: [], exclude: [] },
  country: { include: [], exclude: [] },
  emailStatus: { include: [], exclude: [] },
  phoneType: { include: [], exclude: [] },
  virtualFilters: {
    combinator: "and",
    groups: [
      {
        combinator: "and",
        conditions: [
          { key: "testEnrichment1", type: "text", value: ["test1", "test2"], operator: "is" },
          { key: "testEnrichment2", type: "text", value: ["test6"], operator: "is" },
        ],
      },
    ],
  },
  pushStatus: null,
};

const res = await admin
  .rpc("companies_matching_virtual_filters", { filters: payload }, { count: "exact" })
  .range(0, 9);
console.log("RPC error:", res.error?.message ?? "none");
console.log("RPC count:", res.count, "| first rows:", (res.data ?? []).length);
console.log("sample ids:", (res.data ?? []).slice(0, 5).map((r) => r.id));

// Simpler: single condition, is
async function tryVF(vf, label) {
  const p = { ...payload, virtualFilters: vf };
  const r = await admin.rpc("companies_matching_virtual_filters", { filters: p }, { count: "exact" }).range(0, 3);
  console.log(`${label}: err=${r.error?.message ?? "none"} count=${r.count}`);
}

await tryVF({ combinator: "and", groups: [{ combinator: "and", conditions: [{ key: "testEnrichment1", type: "text", value: ["test1"], operator: "is" }] }] }, "only testEnrichment1 is test1");
await tryVF({ combinator: "and", groups: [{ combinator: "and", conditions: [{ key: "testEnrichment1", type: "text", value: [], operator: "not_empty" }] }] }, "testEnrichment1 not_empty");
await tryVF({ combinator: "and", groups: [{ combinator: "and", conditions: [{ key: "testEnrichment1", type: "text", value: ["test1", "test2"], operator: "contains" }] }] }, "testEnrichment1 contains test1/test2");

// What enrichment values actually exist in custom_data for these keys?
const { data: sample } = await admin
  .from("companies")
  .select("id, custom_data")
  .not("custom_data", "is", null)
  .limit(2000);
const vals1 = new Set();
const vals2 = new Set();
let withKey1 = 0, withKey2 = 0;
for (const r of sample ?? []) {
  const cd = r.custom_data || {};
  if ("testEnrichment1" in cd) { withKey1++; vals1.add(JSON.stringify(cd.testEnrichment1)); }
  if ("testEnrichment2" in cd) { withKey2++; vals2.add(JSON.stringify(cd.testEnrichment2)); }
}
console.log(`\nOf ${sample?.length} sampled companies w/ custom_data: key testEnrichment1 on ${withKey1}, testEnrichment2 on ${withKey2}`);
console.log("testEnrichment1 distinct values:", [...vals1].slice(0, 20));
console.log("testEnrichment2 distinct values:", [...vals2].slice(0, 20));
