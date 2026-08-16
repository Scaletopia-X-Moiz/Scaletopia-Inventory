import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLIENTS = { testing:"0c556239-1608-41fc-9fda-89196c55a56f", internal:"a8dfe6bc-dd09-4146-b628-fc0eacce34f3" };
const TAG="claude-qa-2026-08";
function chunk(a,n){const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o;}
async function mapLimit(items,limit,fn){const out=new Array(items.length);let i=0;await Promise.all(Array.from({length:Math.min(limit,items.length)},async()=>{while(i<items.length){const idx=i++;out[idx]=await fn(items[idx],idx);}}));return out;}

for (const [cname,cid] of Object.entries(CLIENTS)) {
  const { data: client } = await admin.from("clients").select("emailbison_api_key,emailbison_workspace_id").eq("id",cid).single();
  const base=(client.emailbison_workspace_id||"").replace(/\/$/,"");
  const headers={Authorization:`Bearer ${client.emailbison_api_key}`,Accept:"application/json"};
  // company platform_pushes for this client
  const { data: rows } = await admin.from("platform_pushes").select("company_id,platform_contact_id,pushed_at").eq("client_id",cid).eq("platform","emailbison").not("company_id","is",null).order("pushed_at",{ascending:false});
  const leads=(rows??[]).filter(r=>r.platform_contact_id);
  console.log(`\n=== client=${cname}: company leads recorded = ${leads.length} ===`);
  if(!leads.length) continue;
  console.log(`  latest company push_at: ${leads[0].pushed_at}`);
  // sample read-back of custom vars
  const sample = leads.slice(0,120);
  const dist={}; let empty=0;
  await mapLimit(sample,8,async(r)=>{
    const resp=await fetch(`${base}/api/leads/${r.platform_contact_id}`,{headers});
    if(!resp.ok) return;
    const j=await resp.json().catch(()=>null); const lead=j?.data??j;
    const names=(lead?.custom_variables??[]).map(cv=>cv?.name??cv?.variable?.name).filter(Boolean);
    if(names.length===0) empty++;
    for(const n of names) dist[n]=(dist[n]||0)+1;
  });
  console.log(`  sampled ${sample.length} leads: empty(no vars)=${empty}`);
  console.log(`  custom-var name distribution:`, JSON.stringify(dist));
}
