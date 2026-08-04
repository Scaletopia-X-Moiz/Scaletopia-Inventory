import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

const CLIENT_ID = "a8dfe6bc-dd09-4146-b628-fc0eacce34f3"; // Internal

const { data: client, error } = await admin
  .from("clients")
  .select("id, name, emailbison_api_key, emailbison_workspace_id")
  .eq("id", CLIENT_ID)
  .single();
if (error) throw error;

const base = client.emailbison_workspace_id;
const headers = {
  Authorization: `Bearer ${client.emailbison_api_key}`,
  "Content-Type": "application/json",
  Accept: "application/json",
};

async function call(method, path, body) {
  const resp = await fetch(`${base}${path}`, {
    method,
    headers,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await resp.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = text;
  }
  return { status: resp.status, json };
}

function show(label, r) {
  console.log(`\n=== ${label} ===`);
  console.log("status:", r.status);
  console.log(JSON.stringify(r.json, null, 2).slice(0, 2000));
}

// 1. Create campaign
const created = await call("POST", "/api/campaigns", { name: "CLAUDE_API_TEST - delete me" });
show("POST /api/campaigns (create)", created);
const campaignId = created.json?.data?.id ?? created.json?.id;
if (!campaignId) {
  console.error("No campaign id in response, aborting further steps");
  process.exit(1);
}
console.log("Created campaign id:", campaignId);

// 2. Attach a sender email (use first sender from list)
const senders = await call("GET", "/api/sender-emails");
const senderId = senders.json?.data?.[0]?.id;
console.log("Using sender id:", senderId);
const attach = await call("POST", `/api/campaigns/${campaignId}/attach-sender-emails`, {
  sender_email_ids: [senderId],
});
show("POST attach-sender-emails", attach);

// 3. Create schedule
const schedule = await call("POST", `/api/campaigns/${campaignId}/schedule`, {
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false,
  sunday: false,
  start_time: "09:00",
  end_time: "17:00",
  timezone: "America/New_York",
  save_as_template: false,
});
show("POST schedule", schedule);

// 4. Create sequence steps (single simple step, no variant fields)
const seq = await call("POST", `/api/campaigns/${campaignId}/sequence-steps`, {
  title: "test sequence",
  sequence_steps: [
    {
      email_subject: "Hello {FIRST_NAME}",
      email_body: "This is a verification test email body.",
      wait_in_days: 1,
      thread_reply: false,
    },
  ],
});
show("POST sequence-steps", seq);

// 5. Re-fetch campaign, schedule, sequence-steps to confirm persisted state
show("GET campaign after writes", await call("GET", `/api/campaigns/${campaignId}`));
show("GET schedule after write", await call("GET", `/api/campaigns/${campaignId}/schedule`));
show("GET sequence-steps after write", await call("GET", `/api/campaigns/${campaignId}/sequence-steps`));

// 6. Try to delete the test campaign
show("DELETE campaign", await call("DELETE", `/api/campaigns/${campaignId}`));
show("GET campaign after delete (confirm gone)", await call("GET", `/api/campaigns/${campaignId}`));
