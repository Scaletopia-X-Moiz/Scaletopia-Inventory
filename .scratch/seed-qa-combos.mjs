import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });
import { createClient } from "@supabase/supabase-js";
const admin = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const TAG = "claude-qa-2026-08";
const cp = async (mods) => { let q = admin.from("people").select("*", { count: "exact", head: true }).contains("source_tokens", [TAG]); for (const m of mods) q = m(q); const { count, error } = await q; return error ? "ERR " + error.message : count; };
const cc = async (mods) => { let q = admin.from("companies").select("*", { count: "exact", head: true }).contains("source_tokens", [TAG]); for (const m of mods) q = m(q); const { count, error } = await q; return error ? "ERR " + error.message : count; };

console.log("S1 people industry=software development:", await cp([q => q.eq("industry_id", "software development")])); // 1000
console.log("S2 people industry=software development & country=GB:", await cp([q => q.eq("industry_id", "software development").eq("country_id", "GB")])); // 100
console.log("S3 people country=CA:", await cp([q => q.eq("country_id", "CA")])); // 1000
console.log("S4 people niche=qa-uncleaned:", await cp([q => q.contains("niche_tokens", ["qa-uncleaned"])])); // 300
console.log("S5 people industry=retail & country=DE:", await cp([q => q.eq("industry_id", "retail").eq("country_id", "DE")])); // 100
console.log("S6 people niche=qa-noemail:", await cp([q => q.contains("niche_tokens", ["qa-noemail"])])); // 100
console.log("S7 people industry=hospitality (mix valid+noemail):", await cp([q => q.eq("industry_id", "hospitality")])); // 1100
console.log("   S7 breakdown email IS NULL:", await cp([q => q.eq("industry_id", "hospitality").is("email", null)])); // 100
console.log("S10 people industry=education & country=US:", await cp([q => q.eq("industry_id", "education").eq("country_id", "US")])); // 100

console.log("\nS8 companies country=GB:", await cc([q => q.eq("country_id", "GB")])); // 50
const { data: gb } = await admin.from("companies").select("id").contains("source_tokens", [TAG]).eq("country_id", "GB");
const { count: gbPeople } = await admin.from("people").select("*", { count: "exact", head: true }).in("company_id", (gb ?? []).map(c => c.id));
console.log("   S8 linked people:", gbPeople); // 1000
console.log("S9 companies niche=qa-orphan-nopeople:", await cc([q => q.eq("niche", "qa-orphan-nopeople")])); // 10
const { data: orph } = await admin.from("companies").select("id").contains("source_tokens", [TAG]).eq("niche", "qa-orphan-nopeople");
const { count: orphPeople } = await admin.from("people").select("*", { count: "exact", head: true }).in("company_id", (orph ?? []).map(c => c.id));
console.log("   S9 linked people (expect 0):", orphPeople);
