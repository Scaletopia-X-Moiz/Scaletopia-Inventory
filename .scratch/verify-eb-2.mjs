import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "fs";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: client } = await admin.from("clients").select("emailbison_api_key, emailbison_workspace_id").eq("id", "a8dfe6bc-dd09-4146-b628-fc0eacce34f3").single();
const base = client.emailbison_workspace_id;
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, "Content-Type": "application/json", Accept: "application/json" };
async function call(method, path) {
  const resp = await fetch(`${base}${path}`, { method, headers });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: resp.status, json };
}
async function lead(email) {
  const r = await call("GET", `/api/leads?search=${encodeURIComponent(email)}`);
  const d = r.json?.data ?? r.json;
  if (!Array.isArray(d)) return null;
  return d.find((x) => (x.email ?? "").toLowerCase() === email.toLowerCase()) ?? null;
}
const S = JSON.parse(readFileSync("D:/Scaletopia/Scaletopia-Inventory/.scratch/verify-samples.json", "utf8"));
const arg = process.argv[2] ?? "S4";

if (arg === "dumpDE") {
  console.log("=== FULL DE-retail lead dumps ===");
  for (const rec of S.deRetail.slice(0,2)) {
    const l = await lead(rec.email);
    console.log(JSON.stringify(l, null, 2));
  }
}

if (arg === "S4") {
  console.log("=== S4: ALL 300 uncleaned leads company check ===");
  let blank=0, correct=0, wrong=0, missing=0; const bad=[];
  for (const rec of S.uncleanedMeta) {
    const l = await lead(rec.email);
    if (!l) { missing++; bad.push(`MISSING ${rec.email}`); continue; }
    const c = l.company;
    const expected = rec.company_name; // "Raw Uncleaned Co NNNN"
    if (c === null || c === "") { blank++; bad.push(`BLANK ${rec.email}`); }
    else if (c === expected) correct++;
    else { wrong++; bad.push(`WRONG ${rec.email} got=${JSON.stringify(c)} exp=${expected}`); }
  }
  console.log(`  total=${S.uncleanedMeta.length} correct=${correct} blank=${blank} wrong=${wrong} missing=${missing}`);
  if (bad.length) console.log("  anomalies (first 20):\n   " + bad.slice(0,20).join("\n   "));
  else console.log("  ALL 300 have correct non-blank company == raw name");
}

if (arg === "S6") {
  console.log("=== S6: qa-noemail people should NOT exist in EB (no email) ===");
  // try searching by a name fragment 'Noe Mail'
  const r = await call("GET", `/api/leads?search=${encodeURIComponent("Noe Mail")}`);
  const d = r.json?.data ?? r.json;
  console.log("  search 'Noe Mail' count:", Array.isArray(d) ? d.length : JSON.stringify(d).slice(0,200));
  if (Array.isArray(d) && d.length) console.log("   sample:", JSON.stringify(d.slice(0,3).map(x=>({email:x.email,name:x.first_name+" "+x.last_name}))));
}

if (arg === "camp") {
  for (const cid of [1069,1071,1072]) {
    const det = await call("GET", `/api/campaigns/${cid}`);
    const name = det.json?.data?.name ?? det.json?.name;
    // leads count
    const lr = await call("GET", `/api/campaigns/${cid}/leads?per_page=1`);
    const meta = lr.json?.meta;
    const total = meta?.total ?? (Array.isArray(lr.json?.data)? lr.json.data.length : "?");
    console.log(`  campaign ${cid} name=${JSON.stringify(name)} status=${det.json?.data?.status} leadsTotal=${total}`);
  }
}
console.log("DONE", arg);
