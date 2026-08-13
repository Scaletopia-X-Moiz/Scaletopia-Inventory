// Probe the EXACT app flow issue #143 will implement:
//   1. create base step via the EXISTING (non-v1.1) POST /api/campaigns/{id}/sequence-steps
//   2. create variant step via the SAME non-v1.1 POST (appends; new step = last)
//   3. v1.1 GET the sequence -> read authoritative order/subject/body for all steps
//   4. v1.1 PUT /api/campaigns/v1.1/sequence-steps/{data.id-from-base-create} with full body
//   5. v1.1 read-back proves variant linked.
// Confirms: (a) non-v1.1-created steps show in v1.1 GET, (b) data.id from the non-v1.1
// create == the sequence_id the v1.1 PUT path needs. Internal only, no deletes.
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

const name = `zzz-APPFLOW ${stamp()}`;
const camp = await call("POST", "/api/campaigns", { name });
const campaignId = camp.json?.data?.id;

// 1) base step via EXISTING non-v1.1 endpoint
const b = await call("POST", `/api/campaigns/${campaignId}/sequence-steps`, { title: name, sequence_steps: [{ email_subject: "Base A", email_body: "<p>A</p>", wait_in_days: 1, thread_reply: false }] });
const sequenceIdFromCreate = b.json?.data?.id;
const baseStepId = b.json?.data?.sequence_steps?.[0]?.id;
console.log(`base create (non-v1.1): HTTP ${b.status}  data.id=${sequenceIdFromCreate}  baseStepId=${baseStepId}`);

// 2) variant step via SAME non-v1.1 endpoint (appends; new step = last)
const v = await call("POST", `/api/campaigns/${campaignId}/sequence-steps`, { title: name, sequence_steps: [{ email_subject: "Variant B", email_body: "<p>B</p>", wait_in_days: 1, thread_reply: false }] });
const stepsFromVariantPost = v.json?.data?.sequence_steps ?? [];
const variantStepId = stepsFromVariantPost[stepsFromVariantPost.length - 1]?.id;
console.log(`variant create (non-v1.1): HTTP ${v.status}  returned ${stepsFromVariantPost.length} steps  newStepId(last)=${variantStepId}`);
console.log(`  variant-post steps: ${JSON.stringify(stepsFromVariantPost.map((s) => ({ id: s.id, order: s.order })))}`);

// 3) v1.1 GET
const g = await call("GET", `/api/campaigns/v1.1/${campaignId}/sequence-steps`);
const gSeqId = g.json?.data?.sequence_id;
const gSteps = g.json?.data?.sequence_steps ?? [];
console.log(`\nv1.1 GET: HTTP ${g.status}  sequence_id=${gSeqId}  steps=${JSON.stringify(gSteps.map((s) => ({ id: s.id, order: s.order, subj: s.email_subject })))}`);
console.log(`  data.id(non-v1.1 create)=${sequenceIdFromCreate}  ===  v1.1 sequence_id=${gSeqId}  ? ${String(sequenceIdFromCreate) === String(gSeqId)}`);

// 4) v1.1 PUT full body, keyed on the data.id from the non-v1.1 create
const putBody = {
  title: name,
  sequence_steps: gSteps.map((s) => ({
    id: s.id,
    email_subject: s.email_subject,
    order: s.order,
    email_body: s.email_body,
    wait_in_days: s.wait_in_days,
    thread_reply: s.thread_reply ?? false,
    ...(s.id === variantStepId ? { variant: true, variant_from_step_id: baseStepId } : { variant: false }),
  })),
};
const put = await call("PUT", `/api/campaigns/v1.1/sequence-steps/${sequenceIdFromCreate}`, putBody);
console.log(`\nv1.1 PUT sequence-steps/${sequenceIdFromCreate}: HTTP ${put.status}`);
if (put.status >= 400) console.log(`  ${JSON.stringify(put.json)}`);

// 5) read-back
const rb = await call("GET", `/api/campaigns/v1.1/${campaignId}/sequence-steps`);
const rbSteps = rb.json?.data?.sequence_steps ?? [];
const linked = rbSteps.find((s) => String(s.id) === String(variantStepId));
const ok = linked?.variant === true && String(linked?.variant_from_step_id) === String(baseStepId);
console.log(`\nread-back: ${JSON.stringify(rbSteps.map((s) => ({ id: s.id, order: s.order, variant: s.variant, vfsid: s.variant_from_step_id })))}`);
console.log(`\n=== ${ok ? "✅ APP FLOW PROVEN" : "❌ FAILED"}: variant ${variantStepId} -> variant=${linked?.variant} vfsid=${linked?.variant_from_step_id} (expected base ${baseStepId}) ===`);
console.log(`left campaign ${campaignId} ("${name}")`);
