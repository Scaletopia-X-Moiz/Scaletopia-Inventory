import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TESTING_ID = "0c556239-1608-41fc-9fda-89196c55a56f";
const { data: client } = await admin.from("clients").select("emailbison_api_key,emailbison_workspace_id").eq("id", TESTING_ID).single();
const base = (client.emailbison_workspace_id || "").replace(/\/$/, "");
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, Accept: "application/json", "Content-Type": "application/json" };

// Existing platform_pushes rows for Testing + emailbison
const { data: pushes, error } = await admin.from("platform_pushes")
  .select("person_id,company_id,platform_contact_id,campaign_tag,pushed_at")
  .eq("client_id", TESTING_ID).eq("platform", "emailbison")
  .not("platform_contact_id", "is", null)
  .order("pushed_at", { ascending: false }).limit(10);
if (error) { console.error(error); process.exit(1); }
console.log(`Recent Testing/emailbison platform_pushes rows: ${pushes?.length ?? 0}`);
for (const p of (pushes ?? []).slice(0, 5)) {
  console.log(`  lead=${p.platform_contact_id} person=${p.person_id ? "y" : "-"} company=${p.company_id ? "y" : "-"} campaign_tag=${p.campaign_tag} at=${p.pushed_at}`);
}

const leadId = pushes?.[0]?.platform_contact_id;
if (leadId) {
  console.log(`\n=== GET /api/leads/${leadId} ===`);
  const r = await fetch(`${base}/api/leads/${leadId}`, { headers });
  const j = await r.json().catch(() => null);
  console.log(`  HTTP ${r.status}`);
  const lead = j?.data ?? j;
  if (lead && typeof lead === "object") {
    console.log("  keys:", Object.keys(lead).join(", "));
    console.log("  company:", JSON.stringify(lead.company), " first:", JSON.stringify(lead.first_name), " title:", JSON.stringify(lead.title), " email:", JSON.stringify(lead.email));
    console.log("  custom_variables:", JSON.stringify(lead.custom_variables));
  } else {
    console.log("  body:", JSON.stringify(j)?.slice(0, 300));
  }
}

// A lead that actually has custom variables — search a qa_ pushed lead
console.log(`\n=== find a lead WITH custom_variables (search page scan) ===`);
outer: for (let page = 1; page <= 5; page++) {
  const r = await fetch(`${base}/api/leads?page=${page}`, { headers });
  const j = await r.json().catch(() => null);
  for (const lead of j?.data ?? []) {
    if (Array.isArray(lead.custom_variables) && lead.custom_variables.length) {
      console.log(`  lead ${lead.id} email=${lead.email}`);
      console.log("  custom_variables:", JSON.stringify(lead.custom_variables));
      break outer;
    }
  }
}
console.log("\nDone.");
