import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: client } = await admin.from("clients").select("emailbison_api_key, emailbison_workspace_id").eq("id","a8dfe6bc-dd09-4146-b628-fc0eacce34f3").single();
const base = client.emailbison_workspace_id;
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, Accept: "application/json" };
const call = async (p) => { const r = await fetch(`${base}${p}`, { headers }); const t=await r.text(); let j; try{j=JSON.parse(t);}catch{j=t;} return {status:r.status,j}; };
const lead = async (email) => { const r=await call(`/api/leads?search=${encodeURIComponent(email)}`); const d=r.j?.data??[]; return d.find(x=>x.email===email)??null; };

// claude-qa people WITH a phone in Supabase
const { data: withPhone } = await admin.from("people")
  .select("email,phone,linkedin_url,domain,company_name")
  .contains("source_tokens",["claude-qa-2026-08"])
  .not("phone","is",null).not("email","is",null).limit(6);
console.log("claude-qa people with non-null phone in Supabase:", withPhone?.length ?? 0);
for (const p of (withPhone??[])) {
  const l = await lead(p.email);
  const cvs = (l?.custom_variables??[]);
  console.log(`\n  ${p.email}`);
  console.log(`    Supabase: phone=${JSON.stringify(p.phone)} domain=${JSON.stringify(p.domain)} linkedin=${JSON.stringify(p.linkedin_url)}`);
  console.log(`    EB native: company=${JSON.stringify(l?.company)} title=${JSON.stringify(l?.title)} (no native phone/website key exists)`);
  console.log(`    EB custom_variables: ${JSON.stringify(cvs)}`);
  const phoneVar = cvs.find(v=>/phone/i.test(v.name));
  const webVar = cvs.find(v=>/web|url|site|domain|linkedin/i.test(v.name));
  console.log(`    -> phone landed as custom var? ${phoneVar?JSON.stringify(phoneVar):"NO"}`);
  console.log(`    -> website/url landed anywhere? ${webVar?JSON.stringify(webVar):"NO"}`);
}

// Hunt across older/real leads for any populated 'phone' or website-like custom var
console.log("\n=== Sample general leads: which custom var names actually appear populated ===");
const r = await call(`/api/leads?per_page=25`);
const some = r.j?.data ?? [];
const seen = {};
for (const l of some) for (const v of (l.custom_variables??[])) { seen[v.name]=(seen[v.name]||0)+1; }
console.log("  custom var names seen on first 25 leads:", JSON.stringify(seen));
// show one lead that has a phone custom var
const phoneLead = some.find(l=>(l.custom_variables??[]).some(v=>/phone/i.test(v.name)));
if (phoneLead) console.log("  example lead w/ phone var:", JSON.stringify({email:phoneLead.email, cvs:phoneLead.custom_variables}));
