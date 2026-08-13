import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
import { writeFileSync } from "node:fs";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: c } = await admin.from("clients").select("emailbison_api_key, emailbison_workspace_id").eq("id", "a8dfe6bc-dd09-4146-b628-fc0eacce34f3").single();
const base = c.emailbison_workspace_id;

const r = await fetch(`${base}/api/reference.openapi`, { headers: { Accept: "application/json" } });
const text = await r.text();
console.log(`spec fetch HTTP ${r.status}, len ${text.length}`);
let spec; try { spec = JSON.parse(text); } catch (e) { console.log("parse fail:", e.message, text.slice(0, 300)); process.exit(1); }
writeFileSync("D:/Scaletopia/Scaletopia-Inventory/.scratch/eb-openapi.json", JSON.stringify(spec, null, 2));

const paths = Object.keys(spec.paths || {}).filter((p) => /sequence|step/i.test(p));
console.log("\n=== sequence/step paths ===");
for (const p of paths) {
  for (const m of Object.keys(spec.paths[p])) {
    const op = spec.paths[p][m];
    if (typeof op !== "object" || !op.responses) continue;
    console.log(`\n${m.toUpperCase()} ${p}  — ${op.summary || op.operationId || ""}`);
    const params = (op.parameters || []).map((x) => `${x.name}(${x.in})`).join(", ");
    if (params) console.log(`  params: ${params}`);
    const body = op.requestBody?.content?.["application/json"]?.schema;
    if (body) console.log(`  body: ${JSON.stringify(body).slice(0, 1500)}`);
  }
}
// dump any schema mentioning variant
console.log("\n=== components schemas mentioning 'variant' ===");
for (const [name, sch] of Object.entries(spec.components?.schemas || {})) {
  const s = JSON.stringify(sch);
  if (/variant/i.test(s)) console.log(`\n[${name}] ${s.slice(0, 1500)}`);
}
