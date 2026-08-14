import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: client } = await admin.from("clients").select("emailbison_api_key, emailbison_workspace_id").eq("id", "a8dfe6bc-dd09-4146-b628-fc0eacce34f3").single();
const base = client.emailbison_workspace_id;
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, Accept: "application/json" };
const call = async (p) => { const r = await fetch(`${base}${p}`, { headers }); const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; } return { status: r.status, j }; };

// 1) Full raw lead object via search AND via /leads/{id}
console.log("========== 1) LEAD via search (person00001) ==========");
const s = await call(`/api/leads?search=${encodeURIComponent("person00001@claude-qa.example")}`);
const l = (s.j?.data ?? []).find(x => x.email === "person00001@claude-qa.example");
console.log("top-level keys:", l ? Object.keys(l).join(", ") : "NONE");
console.log(JSON.stringify(l, null, 2));

if (l?.id) {
  console.log("\n========== 1b) LEAD via /api/leads/{id} (may expose more fields) ==========");
  const one = await call(`/api/leads/${l.id}`);
  const ld = one.j?.data ?? one.j;
  console.log("HTTP", one.status, "top-level keys:", ld && typeof ld === "object" ? Object.keys(ld).join(", ") : "n/a");
  console.log(JSON.stringify(ld, null, 2));
}

// 2) custom variables list
console.log("\n========== 2) /api/custom-variables (all names) ==========");
let page=1, allVars=[];
for(;;){ const r=await call(`/api/custom-variables?page=${page}`); const rows=r.j?.data??[]; allVars.push(...rows); const m=r.j?.meta; if(!m||m.current_page>=m.last_page)break; page++; }
console.log("count:", allVars.length);
console.log(JSON.stringify(allVars.map(v=>({name:v.name, slug:v.slug, type:v.type})), null, 2));

// 3) probe possible schema endpoints
console.log("\n========== 3) probe schema endpoints ==========");
for (const p of ["/api/lead-fields","/api/leads/fields","/api/custom-fields","/api/lead-attributes","/api/fields"]) {
  const r = await call(p);
  console.log(`  ${p} -> HTTP ${r.status} ${typeof r.j==="string"? r.j.slice(0,80) : JSON.stringify(r.j).slice(0,200)}`);
}
