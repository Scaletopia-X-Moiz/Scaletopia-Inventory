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
  const d = r.j?.data ?? r.j; if (!Array.isArray(d)) return null;
  return d.find((x) => (x.email ?? "").toLowerCase() === email.toLowerCase()) ?? null;
}

// discover companies niche column
const { data: oneComp } = await admin.from("companies").select("*").contains("source_tokens",["claude-qa-2026-08"]).limit(1);
const cols = Object.keys(oneComp?.[0] ?? {});
const nicheCol = cols.find(c=>/niche/.test(c));
console.log("companies niche-ish columns:", cols.filter(c=>/niche/.test(c)).join(",") || "(none)");

// S9: orphan companies via whichever niche column
let orphan=[];
if (nicheCol) {
  const { data, error } = await admin.from("companies").select("id,company_name").contains("source_tokens",["claude-qa-2026-08"]).contains(nicheCol,["qa-orphan-nopeople"]);
  if (error) console.log("orphan query err:", error.message); else orphan=data;
}
console.log("S9 orphan companies (niche qa-orphan-nopeople):", orphan.length);
let orphanPeople=0;
for(const c of orphan){ const {count}=await admin.from("people").select("*",{count:"exact",head:true}).eq("company_id",c.id); orphanPeople+=count??0; }
console.log("  total linked people across those orphan companies:", orphanPeople);

// S2 timing
console.log("\nS2 timing — GB∩software-dev leads: title + campaign 1069 + lead created_at (JOB1=22:39:05, S2/JOB2=22:41:20):");
const { data: gbSoft } = await admin.from("people").select("email").contains("source_tokens",["claude-qa-2026-08"]).eq("country_id","GB").eq("industry_id","software development").limit(6);
for(const p of gbSoft){
  const l=await lead(p.email);
  console.log(`  ${p.email} | title=${JSON.stringify(l?.title)} camps=${JSON.stringify((l?.lead_campaign_data??[]).map(c=>({id:c.campaign_id,st:c.status})))} created=${l?.created_at} updated=${l?.updated_at}`);
}
