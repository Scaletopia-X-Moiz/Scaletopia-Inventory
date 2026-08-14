import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: client } = await admin.from("clients").select("emailbison_api_key, emailbison_workspace_id").eq("id", "a8dfe6bc-dd09-4146-b628-fc0eacce34f3").single();
const base = client.emailbison_workspace_id;
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, Accept: "application/json" };
const call = async (p) => { const r = await fetch(`${base}${p}`, { headers }); let j; try { j = await r.json(); } catch {} return { status: r.status, j }; };

// 1) failures[] array true length per failing job
console.log("=== failures[] array lengths (failed count vs stored reasons) ===");
const { data: jobs } = await admin.from("push_jobs").select("id,failed,failures,platform,filters,created_at").gte("created_at","2026-08-14T22:30:00Z").order("created_at");
for (const j of jobs) {
  const f = j.failures ?? [];
  if (j.failed > 0) console.log(`  job ${j.id.slice(0,8)} failed=${j.failed} failuresStored=${f.length}`);
}

// 2) S1 raw company_name check (does the person even have a company_name that SHOULD map?)
const { data: p1 } = await admin.from("people").select("email,company_name,company_id").in("email",["person00001@claude-qa.example","person00004@claude-qa.example"]);
console.log("\n=== S1 people company_name in Supabase (companyName mapping source) ===");
for (const p of p1) console.log(`  ${p.email} company_name=${JSON.stringify(p.company_name)} company_id=${p.company_id}`);

// 3) campaign 1071 sequence steps / variant flags
console.log("\n=== campaign 1071 (QA Campaign A) detail: sequence/variant ===");
const c = await call("/api/campaigns/1071");
const d = c.j?.data ?? c.j;
console.log("  keys:", Object.keys(d||{}).join(","));
const seq = d?.sequence_steps ?? d?.steps ?? d?.sequences;
console.log("  sequence field sample:", JSON.stringify(seq)?.slice(0,600));

// 4) platform_pushes corroboration for today
const { count: ppCount } = await admin.from("platform_pushes").select("*", { count: "exact", head: true }).eq("platform","emailbison").gte("created_at","2026-08-14T22:30:00Z");
console.log("\n=== platform_pushes (emailbison) since run start:", ppCount, "===");
