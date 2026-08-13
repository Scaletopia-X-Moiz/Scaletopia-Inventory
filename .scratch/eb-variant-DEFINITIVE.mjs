// DEFINITIVE test: create an A/B variant exactly per the official v1.1 OpenAPI spec.
// PUT /api/campaigns/v1.1/sequence-steps/{sequence_id}  (sequence_id = campaign.sequence_id)
// variant step: variant:true + variant_from_step_id:<baseStepId>, unique orders.
// Success = v1.1 read shows variant=true AND variant_from_step_id = baseStepId.
// Internal only, no deletes.
import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: client } = await admin.from("clients").select("emailbison_api_key, emailbison_workspace_id").eq("id", "a8dfe6bc-dd09-4146-b628-fc0eacce34f3").single();
const base = client.emailbison_workspace_id;
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, "Content-Type": "application/json", Accept: "application/json" };
async function call(method, path, body) {
  const resp = await fetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
  const text = await resp.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: resp.status, json };
}
const stamp = () => new Date().toISOString().replace(/[:.]/g, "-") + "-" + Math.floor(Math.random() * 1e4);
const wire = (s) => ({ id: s.id, email_subject: s.email_subject, order: s.order, email_body: s.email_body, wait_in_days: s.wait_in_days, thread_reply: s.thread_reply });

const name = `zzz-DEFINITIVE ${stamp()}`;
const camp = await call("POST", "/api/campaigns", { name });
const campaignId = camp.json?.data?.id;

// base step (v1.1 create)
const b = await call("POST", `/api/campaigns/v1.1/${campaignId}/sequence-steps`, { title: name, sequence_steps: [{ email_subject: "Base A", email_body: "<p>A</p>", wait_in_days: 1, thread_reply: false }] });
const sequenceId = b.json?.data?.id;                       // sequence id (== campaign.sequence_id)
const baseStepId = b.json?.data?.sequence_steps?.[0]?.id;
// variant step (v1.1 create, plain for now)
const v = await call("POST", `/api/campaigns/v1.1/${campaignId}/sequence-steps`, { title: name, sequence_steps: [{ email_subject: "Variant B", email_body: "<p>B</p>", wait_in_days: 1, thread_reply: false }] });
const allSteps = v.json?.data?.sequence_steps ?? [];
const variantStep = allSteps[allSteps.length - 1];
console.log(`campaign ${campaignId}, sequence ${sequenceId}, base ${baseStepId}, variant ${variantStep.id}`);

// PUT the whole sequence per v1.1 spec, marking the variant
const putBody = {
  title: name,
  sequence_steps: allSteps.map((s) =>
    s.id === variantStep.id
      ? { ...wire(s), variant: true, variant_from_step_id: baseStepId }
      : { ...wire(s), variant: false }
  ),
};
const res = await call("PUT", `/api/campaigns/v1.1/sequence-steps/${sequenceId}`, putBody);
console.log(`\nPUT /api/campaigns/v1.1/sequence-steps/${sequenceId} -> HTTP ${res.status}`);
if (res.status >= 400) console.log(JSON.stringify(res.json));

const read = await call("GET", `/api/campaigns/v1.1/${campaignId}/sequence-steps`);
const steps = read.json?.data?.sequence_steps ?? [];
console.log(`\nv1.1 read-back:`);
console.log(JSON.stringify(steps.map((s) => ({ id: s.id, order: s.order, subj: s.email_subject, variant: s.variant, variant_from_step_id: s.variant_from_step_id })), null, 2));

const linked = steps.find((s) => s.id === variantStep.id);
const ok = linked?.variant === true && linked?.variant_from_step_id === baseStepId;
console.log(`\n=== ${ok ? "✅ PROVEN" : "❌ NOT LINKED"}: variant step ${variantStep.id} -> variant=${linked?.variant}, variant_from_step_id=${linked?.variant_from_step_id} (expected ${baseStepId}) ===`);
console.log(`campaign left in place: ${campaignId} ("${name}")`);
