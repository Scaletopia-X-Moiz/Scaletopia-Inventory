/** Edge-case sub-seeds for two top regression risks:
 *  1) UNCLEANED companies (brand_name = null) + linked people, so a
 *     companyName->brandName mapping must FALL BACK to the raw company_name
 *     (bug 7942be4). Marker: niche_tokens ["qa-uncleaned"], niche "qa-uncleaned".
 *  2) NO-EMAIL people (email = null) so a push reports per-lead
 *     "no email on record" failures (bug f56f3ca/9539058).
 *     Marker: niche_tokens ["qa-noemail"], niche via tags.
 *  All still carry source_tokens ["claude-qa-2026-08", ...] so the master
 *  cleanup (delete where source_tokens @> claude-qa-2026-08) removes them too.
 *  Guarded so re-running won't duplicate. */
import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TAG = "claude-qa-2026-08";
const NOW = new Date().toISOString();
const pad = (n) => String(n).padStart(4, "0");

// ---------- 1) UNCLEANED companies + people ----------
const { count: unclExisting } = await admin.from("people").select("*", { count: "exact", head: true })
  .contains("niche_tokens", ["qa-uncleaned"]);
if (!unclExisting) {
  // 15 uncleaned companies: brand_name = null (never cleaned)
  const cos = Array.from({ length: 15 }, (_, i) => {
    const slug = `qa-uncleaned-co-${pad(i + 1)}`;
    return {
      company_name: `Raw Uncleaned Co ${pad(i + 1)}`, brand_name: null,
      domain: `${slug}.claude-qa.example`, website_url: `https://${slug}.claude-qa.example`,
      linkedin_url: `https://www.linkedin.com/company/${slug}`,
      industry: "marketing and advertising", industry_id: "marketing and advertising",
      employee_count: 75, city: "Denver", state: "CO", country: "United States", country_id: "US",
      phone: `+1720555${pad(i)}`, phone_type: "mobile",
      email: `hello@${slug}.claude-qa.example`, email_status: "ok", quality_tier: "B",
      source: `${TAG} & apollo`, source_tokens: [TAG, "apollo"], client: "claude-qa",
      niche: "qa-uncleaned", tags: ["claude-qa-seed", "qa-uncleaned"], last_updated: NOW,
    };
  });
  const cr = await admin.from("companies").insert(cos).select("id,company_name,linkedin_url");
  if (cr.error) { console.error("uncleaned company insert failed:", cr.error); process.exit(1); }
  // 300 people linked to them, company_name = the RAW name (what fallback must send)
  const ppl = Array.from({ length: 300 }, (_, i) => {
    const co = cr.data[i % cr.data.length];
    const slug = `qa-uncleaned-person${pad(i + 1)}`;
    return {
      company_id: co.id, first_name: "Unc", last_name: "Leaned", full_name: `Unc Leaned ${pad(i + 1)}`,
      email: `${slug}@claude-qa.example`, phone: `+1720777${pad(i)}`, job_title: "Founder",
      linkedin_url: `https://www.linkedin.com/in/${slug}`, linkedin_username: slug,
      city: "Denver", state: "CO", country: "United States", country_id: "US",
      company_name: co.company_name, // RAW name — must survive the brand fallback
      domain: `${slug}.claude-qa.example`, company_linkedin_url: co.linkedin_url,
      industry_id: "marketing and advertising", employee_count: 75,
      email_status: "ok", phone_type: "mobile",
      source: `${TAG} & apollo`, source_tokens: [TAG, "apollo"], niche_tokens: ["qa-uncleaned"],
      tags: ["claude-qa-seed", "qa-uncleaned"], last_updated: NOW,
    };
  });
  const pr = await admin.from("people").insert(ppl).select("id");
  console.log("uncleaned: companies=15 people=", pr.error ? pr.error.message : pr.data.length);
} else {
  console.log("uncleaned people already present:", unclExisting);
}

// ---------- 2) NO-EMAIL people ----------
const { count: noEmailExisting } = await admin.from("people").select("*", { count: "exact", head: true })
  .contains("niche_tokens", ["qa-noemail"]);
if (!noEmailExisting) {
  const ppl = Array.from({ length: 100 }, (_, i) => {
    const slug = `qa-noemail-person${pad(i + 1)}`;
    return {
      company_id: null, first_name: "Noe", last_name: "Mail", full_name: `Noe Mail ${pad(i + 1)}`,
      email: null, phone: `+1305777${pad(i)}`, job_title: "Owner",
      linkedin_url: `https://www.linkedin.com/in/${slug}`, linkedin_username: slug,
      city: "Miami", state: "FL", country: "United States", country_id: "US",
      company_name: `QA NoEmail Co ${pad(i + 1)}`, domain: `${slug}.claude-qa.example`,
      industry_id: "hospitality", employee_count: 20, email_status: null, phone_type: "mobile",
      source: `${TAG} & apollo`, source_tokens: [TAG, "apollo"], niche_tokens: ["qa-noemail"],
      tags: ["claude-qa-seed", "qa-noemail"], last_updated: NOW,
    };
  });
  const pr = await admin.from("people").insert(ppl).select("id");
  console.log("no-email people=", pr.error ? pr.error.message : pr.data.length);
} else {
  console.log("no-email people already present:", noEmailExisting);
}

// ---------- verify ----------
const c = async (mods) => { let q = admin.from("people").select("*", { count: "exact", head: true }); for (const m of mods) q = m(q); const { count } = await q; return count; };
console.log("\nverify uncleaned people:", await c([q => q.contains("niche_tokens", ["qa-uncleaned"])]));
console.log("verify no-email people:", await c([q => q.contains("niche_tokens", ["qa-noemail"])]));
console.log("grand total tagged people:", await c([q => q.contains("source_tokens", [TAG])]));
