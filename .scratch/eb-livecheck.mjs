import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TESTING_ID = "0c556239-1608-41fc-9fda-89196c55a56f";
const { data: client } = await admin.from("clients").select("emailbison_api_key,emailbison_workspace_id").eq("id", TESTING_ID).single();
const base = (client.emailbison_workspace_id || "").replace(/\/$/, "");
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, Accept: "application/json" };
const r = await fetch(`${base}/api/leads?search=claude-qa`, { headers });
const j = await r.json().catch(()=>null);
console.log("status", r.status);
console.log("total/meta:", JSON.stringify(j?.meta ?? j?.total ?? Object.keys(j||{})));
console.log("first few:", JSON.stringify((j?.data ?? j ?? []).slice?.(0,5)));

// also count all platform_pushes ever for Testing/emailbison
const { count } = await admin.from("platform_pushes").select("*",{count:"exact",head:true}).eq("client_id", TESTING_ID).eq("platform","emailbison");
console.log("total platform_pushes rows ever for Testing/emailbison:", count);
