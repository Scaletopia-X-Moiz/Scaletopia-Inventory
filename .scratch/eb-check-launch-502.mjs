import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });
const CLIENT_ID = "a8dfe6bc-dd09-4146-b628-fc0eacce34f3";
const { data: client } = await admin.from("clients").select("id, name, emailbison_api_key, emailbison_workspace_id").eq("id", CLIENT_ID).single();
const base = client.emailbison_workspace_id;
const headers = { Authorization: `Bearer ${client.emailbison_api_key}`, "Content-Type": "application/json", Accept: "application/json" };
const resp = await fetch(`${base}/api/campaigns`, { headers });
console.log("status", resp.status);
const json = await resp.json();
console.log(JSON.stringify(json?.data?.slice ? json.data.slice(0,10) : json, null, 2).slice(0,3000));
