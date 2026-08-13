// Try to fetch the OpenAPI/Swagger spec for the Internal workspace and pull the
// sequence-steps + variant definitions. Internal only, read-only.
import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const { data: client } = await admin.from("clients").select("emailbison_api_key, emailbison_workspace_id").eq("id", "a8dfe6bc-dd09-4146-b628-fc0eacce34f3").single();
const base = client.emailbison_workspace_id;
const authHeaders = { Authorization: `Bearer ${client.emailbison_api_key}`, Accept: "application/json" };

const candidates = [
  "/api/reference",
  "/api/openapi.json", "/openapi.json", "/api/openapi", "/api/docs/openapi.json",
  "/docs/api.json", "/api/swagger.json", "/swagger.json",
  "/api/reference.json", "/api/documentation/json", "/api.json",
];
for (const path of candidates) {
  try {
    const resp = await fetch(`${base}${path}`, { headers: authHeaders });
    const ct = resp.headers.get("content-type") || "";
    const text = await resp.text();
    const looksSpec = text.includes("openapi") || text.includes("swagger") || text.includes("sequence-steps") || text.includes("paths");
    console.log(`${path.padEnd(28)} HTTP ${resp.status}  ct=${ct.slice(0,40).padEnd(40)} len=${text.length} ${looksSpec ? "<<< SPEC-LIKE" : ""}`);
    if (looksSpec && (ct.includes("json") || text.trim().startsWith("{"))) {
      try {
        const spec = JSON.parse(text);
        // find sequence-step paths
        const paths = Object.keys(spec.paths || {}).filter((p) => /sequence|step/i.test(p));
        console.log("  matching paths:", JSON.stringify(paths, null, 2));
        for (const p of paths) {
          const methods = spec.paths[p];
          for (const m of Object.keys(methods)) {
            const op = methods[m];
            const bodySchema = op.requestBody?.content?.["application/json"]?.schema;
            console.log(`  ${m.toUpperCase()} ${p}`);
            if (bodySchema) console.log("    body:", JSON.stringify(bodySchema).slice(0, 800));
          }
        }
        // Search components for variant fields
        const compStr = JSON.stringify(spec.components || {});
        const idx = compStr.indexOf("variant");
        if (idx >= 0) console.log("  components variant context:", compStr.slice(Math.max(0, idx - 200), idx + 400));
      } catch (e) { console.log("  (not parseable JSON:", e.message, ")"); }
    }
  } catch (e) {
    console.log(`${path.padEnd(28)} ERROR ${e.message}`);
  }
}
