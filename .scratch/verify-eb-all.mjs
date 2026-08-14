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
  if (!Array.isArray(d)) return { status: r.status, lead: null, raw: r.json };
  const exact = d.find((x) => (x.email ?? "").toLowerCase() === email.toLowerCase());
  return { status: r.status, lead: exact ?? null, count: d.length };
}
const cv = (l, name) => (l?.custom_variables ?? []).find((v) => v.name === name)?.value;
const S = JSON.parse(readFileSync("D:/Scaletopia/Scaletopia-Inventory/.scratch/verify-samples.json", "utf8"));

const arg = process.argv[2] ?? "all";

if (arg === "S1" || arg === "all") {
  console.log("\n########## S1: software-dev custom vars ##########");
  for (const email of S.softwareDev) {
    const { lead: l } = await lead(email);
    if (!l) { console.log(`  MISSING ${email}`); continue; }
    console.log(`  ${email} | title=${JSON.stringify(l.title)} company=${JSON.stringify(l.company)} | qa_city=${cv(l,"qa_city")} qa_state=${cv(l,"qa_state")} qa_company_domain=${cv(l,"qa_company_domain")} qa_employees=${cv(l,"qa_employees")} | camps=${JSON.stringify((l.lead_campaign_data??[]).map(c=>c.campaign_id))}`);
  }
}

if (arg === "S2" || arg === "all") {
  console.log("\n########## S2: GB & software-dev title (static QA_STATIC_VALUE attempted, attach failed) ##########");
  for (const email of S.gbSoft) {
    const { lead: l } = await lead(email);
    if (!l) { console.log(`  MISSING ${email}`); continue; }
    console.log(`  ${email} | title=${JSON.stringify(l.title)} | camps=${JSON.stringify((l.lead_campaign_data??[]).map(c=>c.campaign_id))}`);
  }
}

if (arg === "S3" || arg === "all") {
  console.log("\n########## S3: CA leads final title (put+title skip => expect BLANK) ##########");
  let blank=0, titleCA=0, other=0, missing=0;
  const details=[];
  for (const email of S.ca) {
    const { lead: l } = await lead(email);
    if (!l) { missing++; continue; }
    const t = l.title;
    if (t === null || t === "" ) blank++;
    else if (t === "TITLE_CA" || t === "TITLE-CA") titleCA++;
    else other++;
    details.push(`${email}=${JSON.stringify(t)} company=${JSON.stringify(l.company)}`);
  }
  console.log("  sample:", details.join(" | "));
  console.log(`  blank=${blank} titleCA=${titleCA} other=${other} missing=${missing}`);
}

if (arg === "S5" || arg === "all") {
  console.log("\n########## S5: DE & retail company == 'QA Brand NNNN' ##########");
  for (const rec of S.deRetail) {
    const { lead: l } = await lead(rec.email);
    if (!l) { console.log(`  MISSING ${rec.email}`); continue; }
    console.log(`  ${rec.email} | EBcompany=${JSON.stringify(l.company)} | expected brand=${rec.brand} raw=${rec.company_name}`);
  }
}

if (arg === "S7" || arg === "all") {
  console.log("\n########## S7: hospitality leads exist ##########");
  for (const email of S.hospitality) {
    const { lead: l } = await lead(email);
    console.log(`  ${email} | ${l ? "EXISTS company="+JSON.stringify(l.company) : "MISSING"}`);
  }
}

if (arg === "S10" || arg === "all") {
  console.log("\n########## S10: education&US campaign membership (A=1071 in-seq, NOT B=1072) ##########");
  for (const email of S.eduUs) {
    const { lead: l } = await lead(email);
    if (!l) { console.log(`  MISSING ${email}`); continue; }
    console.log(`  ${email} | camps=${JSON.stringify((l.lead_campaign_data??[]).map(c=>({id:c.campaign_id,st:c.status})))}`);
  }
}
console.log("\nDONE", arg);
