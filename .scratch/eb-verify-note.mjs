import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CLIENT_ID = "a8dfe6bc-dd09-4146-b628-fc0eacce34f3";

// Replicate the view's pure logic exactly.
function companySourceTotal(job) {
  if (job.entity !== "companies") return null;
  const v = job.options?.sourceEntityTotal;
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function noteText(job) {
  const companies = companySourceTotal(job);
  if (companies === null) return "(no note rendered)";
  const people = job.total;
  const fmt = (n) => n.toLocaleString("en-US");
  return people === 0
    ? `Companies push: ${fmt(companies)} ${companies === 1 ? "company was" : "companies were"} selected, but ${companies === 1 ? "it had" : "none had"} any linked people — 0 leads were sent to EmailBison.`
    : `Companies push: ${fmt(companies)} ${companies === 1 ? "company" : "companies"} selected → resolved to ${fmt(people)} linked ${people === 1 ? "person" : "people"} sent as leads.`;
}

// Insert a throwaway company job mimicking what route.ts writes (options carries sourceEntityTotal).
const { data: inserted, error: insErr } = await admin
  .from("push_jobs")
  .insert({
    client_id: CLIENT_ID, platform: "emailbison_companies", entity: "companies", action: "workspace",
    niche: [], filters: {}, options: { existingLeadBehavior: "patch", sourceEntityTotal: 929 },
    status: "succeeded", total: 0, processed: 0, succeeded: 0, failed: 0, failures: [],
    triggered_by_email: "verify@scratch.local",
  })
  .select("id, entity, total, options")
  .single();
if (insErr) throw insErr;
console.log("round-tripped options:", JSON.stringify(inserted.options));

// Case A: 0 people (the user's exact scenario)
console.log("\nCASE A (0 people):");
console.log(" ", noteText(inserted));

// Case B: some people resolved
console.log("\nCASE B (companies resolved to people):");
console.log(" ", noteText({ entity: "companies", total: 1500, options: { sourceEntityTotal: 929 } }));

// Case C: a People push — must render nothing
console.log("\nCASE C (people push, no note):");
console.log(" ", noteText({ entity: "people", total: 84, options: {} }));

// Case D: legacy company job with no stored count — must render nothing
console.log("\nCASE D (legacy company job, no count):");
console.log(" ", noteText({ entity: "companies", total: 0, options: {} }));

// Cleanup
const { error: delErr } = await admin.from("push_jobs").delete().eq("id", inserted.id);
console.log("\ncleanup:", delErr ? "FAILED " + delErr.message : "deleted test job " + inserted.id);
