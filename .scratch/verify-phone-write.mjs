import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: client } = await admin.from("clients").select("emailbison_api_key, emailbison_workspace_id").eq("id","a8dfe6bc-dd09-4146-b628-fc0eacce34f3").single();
const base = client.emailbison_workspace_id;
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, "Content-Type":"application/json", Accept: "application/json" };
const call = async (method,p,body) => {
  const r = await fetch(`${base}${p}`, { method, headers, ...(body!==undefined?{body:JSON.stringify(body)}:{}) });
  const t = await r.text(); let j; try{j=JSON.parse(t);}catch{j=t;} return {status:r.status,j};
};
const EMAIL = "person00001@claude-qa.example";
const lead = async () => { const r=await call("GET",`/api/leads?search=${encodeURIComponent(EMAIL)}`); const d=r.j?.data??[]; return d.find(x=>x.email===EMAIL)??null; };

// BEFORE
const before = await lead();
console.log("=== BEFORE ===");
console.log("  exists:", !!before, "id:", before?.id);
console.log("  custom_variables:", JSON.stringify(before?.custom_variables));
console.log("  title:", JSON.stringify(before?.title), "company:", JSON.stringify(before?.company));

// WRITE: single lead, phone as a CUSTOM VARIABLE, patch, no top-level phone key
const body = {
  existing_lead_behavior: "patch",
  leads: [ { email: EMAIL, custom_variables: [ { name: "phone", value: "+1PHONE-VAR-TEST-001" } ] } ],
};
console.log("\n=== WRITE request body ===");
console.log(JSON.stringify(body));
const w = await call("POST", "/api/leads/create-or-update/multiple", body);
console.log("\n=== WRITE response ===");
console.log("  HTTP", w.status);
console.log("  body:", JSON.stringify(w.j).slice(0,800));

// READ BACK
const after = await lead();
console.log("\n=== AFTER ===");
console.log("  custom_variables:", JSON.stringify(after?.custom_variables, null, 2));
const phoneVar = (after?.custom_variables??[]).find(v=>v.name==="phone");
console.log("\n  phone custom var registered? ", phoneVar ? "YES -> "+JSON.stringify(phoneVar) : "NO");
console.log("  qa_* vars still present? ", (after?.custom_variables??[]).filter(v=>v.name.startsWith("qa_")).map(v=>v.name).join(",") || "NONE");
