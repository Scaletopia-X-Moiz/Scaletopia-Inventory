// Confirm the WORKING variant-link mechanism, derived from the validation errors:
// PUT /api/campaigns/sequence-steps/{sequenceId} with the FULL step list, each step
// carrying id + order, and the variant step carrying variant:true + variant_from_step_id.
// Internal workspace ONLY. Create-only, NO deletes.

import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLIENT_ID = "a8dfe6bc-dd09-4146-b628-fc0eacce34f3"; // Internal
const { data: client } = await admin.from("clients").select("emailbison_api_key, emailbison_workspace_id").eq("id", CLIENT_ID).single();
const base = client.emailbison_workspace_id;
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, "Content-Type": "application/json", Accept: "application/json" };
async function call(method, path, body) {
  const resp = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await resp.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: resp.status, json };
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.floor(Math.random() * 1e4);
const summ = (listResp) => (Array.isArray(listResp.json?.data) ? listResp.json.data : []).map((s) => ({ id: s.id, order: s.order, subj: s.email_subject, variant: s.variant, variant_from_step: s.variant_from_step, variant_from_step_id: s.variant_from_step_id }));
const wire = (s) => ({ id: s.id, order: s.order, email_subject: s.email_subject, email_body: s.email_body, wait_in_days: s.wait_in_days, thread_reply: s.thread_reply });

const name = `zzz-VCONFIRM ${stamp()}`;
const camp = await call("POST", "/api/campaigns", { name });
const campaignId = camp.json?.data?.id;

// base step
await call("POST", `/api/campaigns/${campaignId}/sequence-steps`, { title: name, sequence_steps: [{ email_subject: "Base A", email_body: "<p>A</p>", wait_in_days: 1, thread_reply: false }] });
// variant step (plain, same sequence)
const add = await call("POST", `/api/campaigns/${campaignId}/sequence-steps`, { title: name, sequence_steps: [{ email_subject: "Variant B", email_body: "<p>B</p>", wait_in_days: 1, thread_reply: false }] });
const sequenceId = add.json?.data?.id;
const steps = add.json?.data?.sequence_steps ?? [];
const baseStep = steps[0];
const variantStep = steps[steps.length - 1];
console.log(`campaign ${campaignId}, sequence ${sequenceId}, base step ${baseStep.id}, variant step ${variantStep.id}`);

// PUT the whole sequence, marking the variant step
const putBody = {
  title: name,
  sequence_steps: steps.map((s) =>
    s.id === variantStep.id
      ? { ...wire(s), variant: true, variant_from_step_id: baseStep.id }
      : { ...wire(s), variant: false }
  ),
};
console.log(`\nPUT body:\n${JSON.stringify(putBody, null, 2)}`);
const res = await call("PUT", `/api/campaigns/sequence-steps/${sequenceId}`, putBody);
console.log(`\nPUT /api/campaigns/sequence-steps/${sequenceId} -> HTTP ${res.status}`);
console.log(JSON.stringify(res.json, null, 2));

const list = await call("GET", `/api/campaigns/${campaignId}/sequence-steps`);
console.log(`\nFINAL steps: ${JSON.stringify(summ(list), null, 2)}`);

const linked = (Array.isArray(list.json?.data) ? list.json.data : []).find((s) => s.id === variantStep.id);
console.log(`\n=== RESULT: variant step ${variantStep.id} -> variant=${linked?.variant}, variant_from_step=${linked?.variant_from_step}, variant_from_step_id=${linked?.variant_from_step_id} ===`);
console.log(linked?.variant === true ? "✅ VARIANT LINKED SUCCESSFULLY" : "❌ still not linked");
