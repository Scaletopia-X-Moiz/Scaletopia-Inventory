// Test the v1.1 sequence-steps endpoints (documented as "enhanced variant support").
// v1.1 create: POST /api/campaigns/v1.1/{campaign_id}/sequence-steps
// v1.1 update: PUT  /api/campaigns/v1.1/sequence-steps/{sequence_id}
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
const readV11 = async (campaignId, label) => {
  const r = await call("GET", `/api/campaigns/v1.1/${campaignId}/sequence-steps`);
  const arr = r.json?.data?.sequence_steps ?? [];
  console.log(`   [${label}] v1.1 read: ${JSON.stringify(arr.map((s) => ({ id: s.id, order: s.order, variant: s.variant, vfsid: s.variant_from_step_id })))}`);
};

const name = `zzz-V11 ${stamp()}`;
const camp = await call("POST", "/api/campaigns", { name });
const campaignId = camp.json?.data?.id;
console.log(`campaign ${campaignId}`);

// v1.1 create base
const c1 = await call("POST", `/api/campaigns/v1.1/${campaignId}/sequence-steps`, { title: name, sequence_steps: [{ email_subject: "Base A", email_body: "<p>A</p>", wait_in_days: 1, thread_reply: false }] });
console.log(`\nv1.1 create base -> HTTP ${c1.status}`);
console.log(JSON.stringify(c1.json, null, 2).slice(0, 1200));
const seqId = c1.json?.data?.sequence_id ?? c1.json?.data?.id;
let baseStepId = c1.json?.data?.sequence_steps?.[0]?.id ?? (Array.isArray(c1.json?.data) ? c1.json.data[0]?.id : undefined);
console.log(`seqId=${seqId} baseStepId=${baseStepId}`);

// v1.1 create variant step
const c2 = await call("POST", `/api/campaigns/v1.1/${campaignId}/sequence-steps`, { title: name, sequence_steps: [{ email_subject: "Variant B", email_body: "<p>B</p>", wait_in_days: 1, thread_reply: false }] });
console.log(`\nv1.1 create variant -> HTTP ${c2.status}`);
const stepsAfter = c2.json?.data?.sequence_steps ?? [];
const variantStepId = stepsAfter[stepsAfter.length - 1]?.id;
console.log(`variantStepId=${variantStepId}`);
await readV11(campaignId, "after creates");

// v1.1 update: PUT /api/campaigns/v1.1/sequence-steps/{sequence_id}  (per CLI: sequence_id = step id, body variant + variant_from_step)
for (const [label, body] of [
  ["A variant=B(str) variant_from_step", { variant: "B", variant_from_step: baseStepId }],
  ["B variant=true variant_from_step_id", { variant: true, variant_from_step_id: baseStepId }],
  ["C variant=true variant_from_step", { variant: true, variant_from_step: baseStepId }],
]) {
  const r = await call("PUT", `/api/campaigns/v1.1/sequence-steps/${variantStepId}`, body);
  console.log(`\nv1.1 PUT sequence-steps/${variantStepId} [${label}] -> HTTP ${r.status}`);
  console.log(`   ${JSON.stringify(r.json).slice(0, 400)}`);
  await readV11(campaignId, label);
}
console.log("\nDONE — no deletes.");
