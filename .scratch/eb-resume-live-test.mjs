import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
const CLIENT_ID = "a8dfe6bc-dd09-4146-b628-fc0eacce34f3";
const { data: client } = await admin
  .from("clients")
  .select("emailbison_api_key, emailbison_workspace_id")
  .eq("id", CLIENT_ID)
  .single();
const base = client.emailbison_workspace_id;
const headers = {
  Authorization: `Bearer ${client.emailbison_api_key}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};
async function call(method, path, body) {
  const resp = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: resp.status, json };
}

const CAMPAIGN_ID = 1005;

console.log("=== Creating sequence steps with valid wait_in_days=1 ===");
const seq = await call("POST", `/api/campaigns/${CAMPAIGN_ID}/sequence-steps`, {
  title: "CLAUDE_UI_VERIFY_LAUNCH_20260804",
  sequence_steps: [
    {
      email_subject: "Placeholder subject {{first_name}}",
      email_body: "This is placeholder body text for QA verification (launch path), never sent to real leads.",
      wait_in_days: 1,
      thread_reply: false,
    },
  ],
});
console.log("status:", seq.status, JSON.stringify(seq.json).slice(0, 500));

console.log("\n=== Confirm campaign has 0 leads before resume ===");
const before = await call("GET", `/api/campaigns/${CAMPAIGN_ID}`);
console.log("total_leads:", before.json?.data?.total_leads, "status:", before.json?.data?.status);

console.log("\n=== PATCH /api/campaigns/{id}/resume (live, first-ever call) ===");
const resume = await call("PATCH", `/api/campaigns/${CAMPAIGN_ID}/resume`);
console.log("status:", resume.status);
console.log("FULL RESPONSE BODY:", JSON.stringify(resume.json, null, 2));

console.log("\n=== GET campaign after resume ===");
const after = await call("GET", `/api/campaigns/${CAMPAIGN_ID}`);
console.log("status field:", after.json?.data?.status, "total_leads:", after.json?.data?.total_leads);
