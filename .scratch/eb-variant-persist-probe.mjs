// Probe why variant_from_step_id doesn't persist. Test order/format variations.
// Read back via v1.1 (which exposes variant_from_step_id). Internal only, no deletes.
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
const wire = (s) => ({ id: s.id, order: s.order, email_subject: s.email_subject, email_body: s.email_body, wait_in_days: s.wait_in_days, thread_reply: s.thread_reply });

async function setup() {
  const name = `zzz-VPERSIST ${stamp()}`;
  const camp = await call("POST", "/api/campaigns", { name });
  const campaignId = camp.json?.data?.id;
  await call("POST", `/api/campaigns/${campaignId}/sequence-steps`, { title: name, sequence_steps: [{ email_subject: "Base A", email_body: "<p>A</p>", wait_in_days: 1, thread_reply: false }] });
  const add = await call("POST", `/api/campaigns/${campaignId}/sequence-steps`, { title: name, sequence_steps: [{ email_subject: "Variant B", email_body: "<p>B</p>", wait_in_days: 1, thread_reply: false }] });
  return { name, campaignId, sequenceId: add.json?.data?.id, steps: add.json?.data?.sequence_steps ?? [] };
}
async function readback(campaignId, label) {
  const r = await call("GET", `/api/campaigns/v1.1/${campaignId}/sequence-steps`);
  const arr = r.json?.data?.sequence_steps ?? [];
  console.log(`   [${label}] v1.1 read: ${JSON.stringify(arr.map((s) => ({ id: s.id, order: s.order, variant: s.variant, vfsid: s.variant_from_step_id })))}`);
}

// Variation 1: variant shares the SAME order as base (both order 1)
async function v1_sameOrder() {
  const c = await setup();
  const [b, v] = [c.steps[0], c.steps[c.steps.length - 1]];
  const body = { title: c.name, sequence_steps: [ { ...wire(b), order: 1, variant: false }, { ...wire(v), order: 1, variant: true, variant_from_step_id: b.id } ] };
  const res = await call("PUT", `/api/campaigns/sequence-steps/${c.sequenceId}`, body);
  console.log(`\n# V1 same-order(1,1) base ${b.id} variant ${v.id} -> PUT ${res.status}` + (res.status >= 400 ? ` ${JSON.stringify(res.json)}` : ""));
  await readback(c.campaignId, "V1");
}
// Variation 2: variant_from_step_id as STRING
async function v2_stringId() {
  const c = await setup();
  const [b, v] = [c.steps[0], c.steps[c.steps.length - 1]];
  const body = { title: c.name, sequence_steps: [ { ...wire(b), variant: false }, { ...wire(v), variant: true, variant_from_step_id: String(b.id) } ] };
  const res = await call("PUT", `/api/campaigns/sequence-steps/${c.sequenceId}`, body);
  console.log(`\n# V2 string-id base ${b.id} variant ${v.id} -> PUT ${res.status}` + (res.status >= 400 ? ` ${JSON.stringify(res.json)}` : ""));
  await readback(c.campaignId, "V2");
}
// Variation 3: same order AND variant_from_step_id, plus also send variant_from_step (both names)
async function v3_sameOrderBothNames() {
  const c = await setup();
  const [b, v] = [c.steps[0], c.steps[c.steps.length - 1]];
  const body = { title: c.name, sequence_steps: [ { ...wire(b), order: 1, variant: false }, { ...wire(v), order: 1, variant: true, variant_from_step_id: b.id, variant_from_step: b.id } ] };
  const res = await call("PUT", `/api/campaigns/sequence-steps/${c.sequenceId}`, body);
  console.log(`\n# V3 same-order+both-names base ${b.id} variant ${v.id} -> PUT ${res.status}` + (res.status >= 400 ? ` ${JSON.stringify(res.json)}` : ""));
  await readback(c.campaignId, "V3");
}

await v1_sameOrder();
await v2_stringId();
await v3_sameOrderBothNames();
console.log("\nDONE — no deletes.");
