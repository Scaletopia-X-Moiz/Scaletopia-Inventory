import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

// load .env.local
for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}

const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const { data, error } = await sb
  .from("platform_pushes")
  .select("person_id,client_id,platform,platform_contact_id,campaign_tag,pushed_at,pushed_by_email")
  .eq("platform", "ghl")
  .order("pushed_at", { ascending: false })
  .limit(10);

if (error) { console.error("ERR", error); process.exit(1); }
for (const r of data) {
  console.log(`${r.pushed_at}  contact=${r.platform_contact_id}  campaign_tag=${JSON.stringify(r.campaign_tag)}  by=${r.pushed_by_email}`);
}
