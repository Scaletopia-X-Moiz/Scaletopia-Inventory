import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";

const url = process.env.SUPABASE_URL;
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

const { data, error } = await admin
  .from("clients")
  .select("id, name, emailbison_api_key, emailbison_workspace_id")
  .not("emailbison_api_key", "is", null)
  .not("emailbison_workspace_id", "is", null);

if (error) {
  console.error(error);
  process.exit(1);
}

console.log(`Found ${data.length} client(s) with EmailBison credentials`);
for (const c of data) {
  console.log({
    id: c.id,
    name: c.name,
    workspaceId: c.emailbison_workspace_id,
    apiKeyPresent: !!c.emailbison_api_key,
    apiKeyLen: c.emailbison_api_key?.length,
  });
}
