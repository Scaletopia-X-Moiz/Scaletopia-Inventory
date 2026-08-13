// Live verification of the EmailBison A/B split-test variant link flow.
// Internal workspace ONLY (client a8dfe6bc-...). Create-only, NO deletes.
// Goal: capture the RAW `POST .../sequence-steps` response shape and prove
// empirically which id value makes `PUT .../sequence-steps/{id}` link a
// variant succeed (200) vs the 404 we see in production.

import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLIENT_ID = "a8dfe6bc-dd09-4146-b628-fc0eacce34f3"; // Internal

const { data: client, error } = await admin
  .from("clients")
  .select("id, name, emailbison_api_key, emailbison_workspace_id")
  .eq("id", CLIENT_ID)
  .single();
if (error) throw error;
console.log(`Workspace: ${client.name} @ ${client.emailbison_workspace_id}\n`);

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
const dump = (label, r) => console.log(`--- ${label} [HTTP ${r.status}] ---\n${JSON.stringify(r.json, null, 2)}\n`);

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const CAMP_NAME = `zzz-API-VARIANT-VERIFY ${stamp}`;

// 1) Create a throwaway campaign
const camp = await call("POST", "/api/campaigns", { name: CAMP_NAME });
dump("POST /api/campaigns", camp);
const campaignId = camp.json?.data?.id;
if (!campaignId) { console.log("No campaign id — stopping."); process.exit(1); }
console.log(`campaignId = ${campaignId}\n`);

// 2) Create the BASE step (mirrors createSequenceSteps: title + sequence_steps[])
const baseCreate = await call("POST", `/api/campaigns/${campaignId}/sequence-steps`, {
  title: CAMP_NAME,
  sequence_steps: [{ email_subject: "Base subject A", email_body: "<p>Base body A</p>", wait_in_days: 1, thread_reply: false }],
});
dump("POST base sequence-steps (RAW create response)", baseCreate);

// 3) List steps — the authoritative addressable ids
const list1 = await call("GET", `/api/campaigns/${campaignId}/sequence-steps`);
dump("GET sequence-steps list (after base)", list1);

// 4) Create the VARIANT step as its own single-step sequence (mirrors app)
const variantCreate = await call("POST", `/api/campaigns/${campaignId}/sequence-steps`, {
  title: CAMP_NAME,
  sequence_steps: [{ email_subject: "Variant subject B", email_body: "<p>Variant body B</p>", wait_in_days: 1, thread_reply: false }],
});
dump("POST variant sequence-steps (RAW create response)", variantCreate);

const list2 = await call("GET", `/api/campaigns/${campaignId}/sequence-steps`);
dump("GET sequence-steps list (after variant)", list2);

// --- Derive candidate ids from each create response + the list ---
const pick = (r) => {
  const d = r.json?.data;
  const asObj = d && !Array.isArray(d) ? d : null;
  return {
    "data.id (top-level)": asObj?.id ?? (Array.isArray(d) ? undefined : undefined),
    "data[0].id (array shape)": Array.isArray(d) ? d[0]?.id : undefined,
    "data.sequence_steps[0].id (current code)": asObj?.sequence_steps?.[0]?.id,
  };
};
console.log("Base create candidate ids:", JSON.stringify(pick(baseCreate), null, 2));
console.log("Variant create candidate ids:", JSON.stringify(pick(variantCreate), null, 2));

const listArr = Array.isArray(list2.json?.data) ? list2.json.data : [];
console.log("List step ids (canonical/addressable):", JSON.stringify(listArr.map((s) => s.id), null, 2), "\n");

// The base step's canonical id and the variant step's canonical id, from the list
const baseStepIdFromList = listArr[0]?.id;
const variantStepIdFromList = listArr[listArr.length - 1]?.id;

// Build the set of PUT-target candidates for the VARIANT, dedup'd
const vCand = pick(variantCreate);
const candidates = [
  ["variant create data.sequence_steps[0].id (CURRENT CODE)", vCand["data.sequence_steps[0].id (current code)"]],
  ["variant create data.id (top-level)", vCand["data.id (top-level)"]],
  ["variant step id from LIST endpoint", variantStepIdFromList],
].filter(([, v], i, arr) => v != null && arr.findIndex(([, x]) => x === v) === i);

console.log(`variant_from_step will use base step id from list = ${baseStepIdFromList}\n`);
console.log("=== PUT link attempts (variant='B', variant_from_step=<base>) ===\n");
for (const [label, id] of candidates) {
  const r = await call("PUT", `/api/campaigns/sequence-steps/${id}`, { variant: "B", variant_from_step: String(baseStepIdFromList) });
  console.log(`>>> ${label}  (id=${id})  ->  HTTP ${r.status}`);
  console.log(`    ${JSON.stringify(r.json)}\n`);
}

console.log(`DONE. Left campaign "${CAMP_NAME}" (id ${campaignId}) in place — not deleted.`);
