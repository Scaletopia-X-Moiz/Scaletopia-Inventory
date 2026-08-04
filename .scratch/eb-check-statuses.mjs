import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

const { data: clients, error } = await admin
  .from("clients")
  .select("id, name, emailbison_api_key, emailbison_workspace_id")
  .not("emailbison_api_key", "is", null)
  .not("emailbison_workspace_id", "is", null);
if (error) throw error;

for (const client of clients) {
  const headers = {
    Authorization: `Bearer ${client.emailbison_api_key}`,
    Accept: "application/json",
  };
  let page = 1;
  const statuses = {};
  let total = 0;
  for (;;) {
    const resp = await fetch(`${client.emailbison_workspace_id}/api/campaigns?page=${page}`, { headers });
    const json = await resp.json();
    const rows = json?.data ?? [];
    for (const c of rows) {
      statuses[c.status] = (statuses[c.status] ?? 0) + 1;
      total++;
    }
    const meta = json?.meta;
    if (!meta || meta.current_page >= meta.last_page) break;
    page++;
  }
  console.log(client.name, "total:", total, "by status:", statuses);
}
