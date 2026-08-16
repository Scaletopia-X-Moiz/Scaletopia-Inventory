import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TAG = "claude-qa-2026-08";
// clients
const { data: clients } = await admin.from("clients").select("id,name").order("name");
// recent emailbison pushes overall
const { data: recent } = await admin.from("platform_pushes")
  .select("client_id,person_id,company_id,pushed_at,platform_contact_id")
  .eq("platform","emailbison").order("pushed_at",{ascending:false}).limit(10);
console.log("Most recent emailbison platform_pushes:");
for (const r of recent ?? []) {
  const c = clients.find(x=>x.id===r.client_id);
  console.log(`  ${r.pushed_at}  client=${c?.name??r.client_id}  person=${r.person_id?"y":"-"} company=${r.company_id?"y":"-"} lead=${r.platform_contact_id}`);
}
// count emailbison pushes per client today
const { data: all } = await admin.from("platform_pushes").select("client_id,pushed_at").eq("platform","emailbison").gte("pushed_at","2026-08-16");
const byClient = {};
for (const r of all ?? []) byClient[r.client_id]=(byClient[r.client_id]||0)+1;
console.log("\nemailbison pushes since 2026-08-16 by client:");
for (const [id,n] of Object.entries(byClient)) console.log(`  ${clients.find(x=>x.id===id)?.name??id}: ${n}`);

// overlap people ids -> any platform_pushes row at all?
let people=[]; for(let f=0;;f+=1000){const{data}=await admin.from("people").select("id").contains("source_tokens",[TAG]).overlaps("niche_tokens",["qa-uncleaned"]).range(f,f+999);people.push(...(data??[]));if(!data||data.length<1000)break;}
const ids=people.map(p=>p.id);
function chunk(a,n){const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o;}
let rows=[];for(const c of chunk(ids,200)){const{data}=await admin.from("platform_pushes").select("client_id,person_id,platform_contact_id,pushed_at").eq("platform","emailbison").in("person_id",c);rows.push(...(data??[]));}
console.log(`\nplatform_pushes rows for the 300 overlap people (any client): ${rows.length}`);
const perC={};for(const r of rows)perC[r.client_id]=(perC[r.client_id]||0)+1;
for(const[id,n]of Object.entries(perC))console.log(`  ${clients.find(x=>x.id===id)?.name??id}: ${n}`);
