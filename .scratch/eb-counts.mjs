import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TAG = "claude-qa-2026-08";

async function count(table, build) {
  let q = admin.from(table).select("id", { count: "exact", head: true }).contains("source_tokens", [TAG]);
  q = build(q);
  const { count, error } = await q;
  if (error) throw error;
  return count;
}

console.log("=== COMPANIES (company-native push: 1 lead per company) ===");
const coNiches = ["b2b-saas", "agency", "ecommerce", "fitness", "dtc-beauty", "qa-uncleaned", "qa-orphan-nopeople"];
for (const n of coNiches) console.log(`  niche=${n}: ${await count("companies", (q) => q.eq("niche", n))}`);
console.log(`  country=United Kingdom: ${await count("companies", (q) => q.eq("country", "United Kingdom"))}`);
console.log(`  country=Germany: ${await count("companies", (q) => q.eq("country", "Germany"))}`);
console.log(`  email IS NULL (company-native no-email → should fail): ${await count("companies", (q) => q.is("email", null))}`);
console.log(`  brand_name IS NULL (companyName raw fallback): ${await count("companies", (q) => q.is("brand_name", null))}`);
console.log(`  TOTAL QA companies: ${await count("companies", (q) => q)}`);

console.log("\n=== PEOPLE ===");
const pNiches = ["agency", "qa-uncleaned", "qa-noemail", "qa-orphan-nopeople"];
for (const n of pNiches) console.log(`  niche_tokens=${n}: ${await count("people", (q) => q.contains("niche_tokens", [n]))}`);
console.log(`  country=United Kingdom: ${await count("people", (q) => q.eq("country", "United Kingdom"))}`);
console.log(`  country=Canada: ${await count("people", (q) => q.eq("country", "Canada"))}`);
console.log(`  email IS NULL (should fail on push): ${await count("people", (q) => q.is("email", null))}`);
console.log(`  TOTAL QA people: ${await count("people", (q) => q)}`);

// distinct people niche_tokens
const { data: pn } = await admin.from("people").select("niche_tokens").contains("source_tokens", [TAG]).limit(11000);
const s = new Set(); for (const r of pn ?? []) for (const t of r.niche_tokens ?? []) s.add(t);
console.log("\n  distinct people niche_tokens:", JSON.stringify([...s]));
// distinct countries (companies)
const { data: cc } = await admin.from("companies").select("country").contains("source_tokens", [TAG]).limit(600);
const sc = new Set(); for (const r of cc ?? []) if (r.country) sc.add(r.country);
console.log("  distinct company countries:", JSON.stringify([...sc]));
console.log("\nDone.");
