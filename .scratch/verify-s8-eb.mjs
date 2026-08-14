import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: client } = await admin.from("clients").select("emailbison_api_key, emailbison_workspace_id").eq("id", "a8dfe6bc-dd09-4146-b628-fc0eacce34f3").single();
const base = client.emailbison_workspace_id;
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, Accept: "application/json" };
const call = async (p) => { const r = await fetch(`${base}${p}`, { headers }); let j; try { j = await r.json(); } catch {} return { status: r.status, j }; };
async function lead(email) {
  const r = await call(`/api/leads?search=${encodeURIComponent(email)}`);
  const d = r.j?.data ?? r.j;
  if (!Array.isArray(d)) return null;
  return d.find((x) => (x.email ?? "").toLowerCase() === email.toLowerCase()) ?? null;
}
const cv = (l, n) => (l?.custom_variables ?? []).find((v) => v.name === n)?.value;

// S8: GB claude-qa companies -> linked people
const PAGE = 1000;
async function fetchAll(build) { const rows=[]; for(let f=0;;f+=PAGE){const {data,error}=await build(admin).range(f,f+PAGE-1); if(error)throw error; rows.push(...data); if(data.length<PAGE)break;} return rows; }

const companies = await fetchAll((a)=>a.from("companies").select("id,company_name,brand_name,country_id,industry").contains("source_tokens",["claude-qa-2026-08"]).eq("country_id","GB"));
console.log("S8 GB claude-qa companies:", companies.length);
console.log("  sample company:", JSON.stringify(companies.slice(0,2).map(c=>({name:c.company_name,brand:c.brand_name,industry:c.industry}))));
const compIds = companies.map(c=>c.id);
// linked people
let people=[];
for(let i=0;i<compIds.length;i+=100){
  const chunk=compIds.slice(i,i+100);
  const {data}=await admin.from("people").select("email,company_id,companies(brand_name,industry)").in("company_id",chunk);
  people.push(...data);
}
const withEmail = people.filter(p=>p.email);
console.log("  linked people:", people.length, "withEmail:", withEmail.length);

// sample 12 leads in EB
console.log("\nS8 EB lead check (12 samples): company blank expected (bug), qa_industry should be set:");
for(const p of withEmail.slice(0,12)){
  const l=await lead(p.email);
  if(!l){console.log(`  MISSING ${p.email}`);continue;}
  console.log(`  ${p.email} | EBcompany=${JSON.stringify(l.company)} qa_industry=${JSON.stringify(cv(l,"qa_industry"))} | srcIndustry=${p.companies?.industry}`);
}

// S9 orphan companies count
const orphan = await fetchAll((a)=>a.from("companies").select("id,company_name,niche").contains("source_tokens",["claude-qa-2026-08"]).contains("niche_tokens",["qa-orphan-nopeople"]));
console.log("\nS9 orphan companies (niche qa-orphan-nopeople):", orphan.length);
let orphanPeople=0;
for(const c of orphan){ const {count}=await admin.from("people").select("*",{count:"exact",head:true}).eq("company_id",c.id); orphanPeople+=count??0; }
console.log("  total linked people across orphan companies:", orphanPeople);

// S2 timing: GB software-dev people campaign 1069 join
console.log("\nS2 timing check — GB∩software-dev leads campaign membership + created_at:");
const gbSoft = await fetchAll((a)=>a.from("people").select("email").contains("source_tokens",["claude-qa-2026-08"]).eq("country_id","GB").eq("industry_id","software development").limit(5));
for(const p of (gbSoft).slice(0,5)){
  const l=await lead(p.email);
  console.log(`  ${p.email} | title=${JSON.stringify(l?.title)} | camps=${JSON.stringify((l?.lead_campaign_data??[]).map(c=>c.campaign_id))} | leadCreated=${l?.created_at}`);
}
