// Find the ACTUAL working mechanism to create an A/B variant in EmailBison.
// Internal workspace ONLY. Create-only, NO deletes.
// Each experiment uses its own fresh campaign so results are isolated.
// Success = after the op, a step shows variant set + variant_from_step = base id.

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

// summarize a step list to just the variant-relevant fields
const summ = (listResp) => (Array.isArray(listResp.json?.data) ? listResp.json.data : []).map((s) => ({ id: s.id, order: s.order, subj: s.email_subject, variant: s.variant, variant_from_step: s.variant_from_step }));

async function freshBase(label) {
  const name = `zzz-VMECH ${label} ${stamp()}`;
  const camp = await call("POST", "/api/campaigns", { name });
  const campaignId = camp.json?.data?.id;
  const b = await call("POST", `/api/campaigns/${campaignId}/sequence-steps`, {
    title: name, sequence_steps: [{ email_subject: "Base A", email_body: "<p>A</p>", wait_in_days: 1, thread_reply: false }],
  });
  const sequenceId = b.json?.data?.id;
  const baseStepId = b.json?.data?.sequence_steps?.[0]?.id;
  return { name, campaignId, sequenceId, baseStepId };
}

// ---------- Experiment 1: variant fields INLINE on the create POST ----------
async function exp1(variantValue) {
  const ctx = await freshBase(`E1(${variantValue})`);
  const res = await call("POST", `/api/campaigns/${ctx.campaignId}/sequence-steps`, {
    title: ctx.name,
    sequence_steps: [{ email_subject: "Variant B", email_body: "<p>B</p>", wait_in_days: 1, thread_reply: false, variant: variantValue, variant_from_step: ctx.baseStepId }],
  });
  const list = await call("GET", `/api/campaigns/${ctx.campaignId}/sequence-steps`);
  console.log(`\n### E1 inline-on-create, variant=${JSON.stringify(variantValue)}  (base step ${ctx.baseStepId}, seq ${ctx.sequenceId})`);
  console.log(`   create HTTP ${res.status}`);
  if (res.status >= 400) console.log(`   err: ${JSON.stringify(res.json)}`);
  console.log(`   steps now: ${JSON.stringify(summ(list))}`);
}

// ---------- Experiment 2: PUT the whole SEQUENCE, step marked as variant ----------
async function exp2(variantValue) {
  const ctx = await freshBase(`E2(${variantValue})`);
  // add a plain 2nd step first (so we have a step id to mark)
  const add = await call("POST", `/api/campaigns/${ctx.campaignId}/sequence-steps`, {
    title: ctx.name, sequence_steps: [{ email_subject: "Variant B", email_body: "<p>B</p>", wait_in_days: 1, thread_reply: false }],
  });
  const steps = add.json?.data?.sequence_steps ?? [];
  const variantStep = steps[steps.length - 1];
  // PUT the sequence with the full step list, marking the last as a variant of the base
  const putBody = {
    title: ctx.name,
    sequence_steps: steps.map((s) =>
      s.id === variantStep.id
        ? { id: s.id, email_subject: s.email_subject, email_body: s.email_body, wait_in_days: s.wait_in_days, thread_reply: s.thread_reply, variant: variantValue, variant_from_step: ctx.baseStepId }
        : { id: s.id, email_subject: s.email_subject, email_body: s.email_body, wait_in_days: s.wait_in_days, thread_reply: s.thread_reply }
    ),
  };
  const res = await call("PUT", `/api/campaigns/sequence-steps/${ctx.sequenceId}`, putBody);
  const list = await call("GET", `/api/campaigns/${ctx.campaignId}/sequence-steps`);
  console.log(`\n### E2 PUT-whole-sequence ${ctx.sequenceId}, variant=${JSON.stringify(variantValue)}  (base ${ctx.baseStepId}, variantStep ${variantStep?.id})`);
  console.log(`   PUT HTTP ${res.status}`);
  if (res.status >= 400) console.log(`   err: ${JSON.stringify(res.json)}`);
  console.log(`   steps now: ${JSON.stringify(summ(list))}`);
}

// ---------- Experiment 3: single create call with BOTH steps, variant inline ----------
async function exp3(variantValue) {
  const name = `zzz-VMECH E3(${variantValue}) ${stamp()}`;
  const camp = await call("POST", "/api/campaigns", { name });
  const campaignId = camp.json?.data?.id;
  // Create base first to learn its id, then a single create with the variant referencing it
  const b = await call("POST", `/api/campaigns/${campaignId}/sequence-steps`, {
    title: name, sequence_steps: [{ email_subject: "Base A", email_body: "<p>A</p>", wait_in_days: 1, thread_reply: false }],
  });
  const baseStepId = b.json?.data?.sequence_steps?.[0]?.id;
  const sequenceId = b.json?.data?.id;
  // Now PUT the sequence adding a NEW variant step (no id) with variant fields
  const res = await call("PUT", `/api/campaigns/sequence-steps/${sequenceId}`, {
    title: name,
    sequence_steps: [
      { id: baseStepId, email_subject: "Base A", email_body: "<p>A</p>", wait_in_days: 1, thread_reply: false },
      { email_subject: "Variant B", email_body: "<p>B</p>", wait_in_days: 1, thread_reply: false, variant: variantValue, variant_from_step: baseStepId },
    ],
  });
  const list = await call("GET", `/api/campaigns/${campaignId}/sequence-steps`);
  console.log(`\n### E3 PUT-sequence add-new-variant-step, variant=${JSON.stringify(variantValue)}  (base ${baseStepId}, seq ${sequenceId})`);
  console.log(`   PUT HTTP ${res.status}`);
  if (res.status >= 400) console.log(`   err: ${JSON.stringify(res.json)}`);
  console.log(`   steps now: ${JSON.stringify(summ(list))}`);
}

await exp1("B");
await exp1(true);
await exp2("B");
await exp2(true);
await exp3("B");
await exp3(true);
console.log("\nDONE — no deletes performed.");
