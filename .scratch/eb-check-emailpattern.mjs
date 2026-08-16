import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const { data, error } = await admin.from("companies").select("id,company_name,brand_name,email,niche,source_tokens").eq("email","hello@qa-co-0065.claude-qa.example");
console.log("company match:", JSON.stringify(data), error);

const { data: d2 } = await admin.from("companies").select("niche").not("niche","is",null).limit(2000);
console.log("distinct niches:", [...new Set(d2.map(r=>r.niche))]);

// paginate platform_pushes properly to get all pushed_at dates
let all = []; 
for (let from=0; ; from+=1000) {
  const { data } = await admin.from("platform_pushes").select("pushed_at").eq("client_id","0c556239-1608-41fc-9fda-89196c55a56f").eq("platform","emailbison").range(from, from+999);
  all.push(...data);
  if (data.length < 1000) break;
}
const buckets = {};
for (const r of all) { const day = r.pushed_at?.slice(0,10); buckets[day] = (buckets[day]||0)+1; }
console.log("full date buckets (n="+all.length+"):", buckets);
