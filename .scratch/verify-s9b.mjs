import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
// company niche is text; try eq and ilike
for (const method of ["eq","ilike"]) {
  let q = admin.from("companies").select("id,company_name,niche").contains("source_tokens",["claude-qa-2026-08"]);
  q = method==="eq" ? q.eq("niche","qa-orphan-nopeople") : q.ilike("niche","%qa-orphan%");
  const { data, error } = await q;
  if (error) { console.log(method, "err", error.message); continue; }
  console.log(`${method}: ${data.length} orphan companies`, JSON.stringify(data.slice(0,3).map(c=>c.company_name)));
  let ppl=0; for(const c of data){ const {count}=await admin.from("people").select("*",{count:"exact",head:true}).eq("company_id",c.id); ppl+=count??0; }
  console.log(`   linked people total: ${ppl}`);
}
