// Read-only reproduction of the "[object Object]" campaign-push bug and its fix.
// Exercises ONLY the platform_pushes SELECT lookup that runEmailBisonAddToCampaign
// runs — no EmailBison calls, no writes. Safe to run repeatedly.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m) process.env[m[1]] ??= m[2].replace(/^["']|["']$/g, "");
}
const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// Same client + source push-job (the 7,735-person set) as the real failed jobs.
const CLIENT_ID = "a8dfe6bc-dd09-4146-b628-fc0eacce34f3";
const SOURCE_JOB = "5a2b1a37-02b1-4478-a16a-3187c8704afe";
const TICK = 2000;             // EMAILBISON_CAMPAIGN_TICK_SIZE
const CHUNK = 200;             // CAMPAIGN_LOOKUP_CHUNK_SIZE (the fix)

// Resolve the pushJobId person set (what the deep-linked "Add to Campaign" saw).
const ids = [];
const { count } = await sb.from("push_job_records").select("person_id", { count: "exact", head: true }).eq("push_job_id", SOURCE_JOB);
for (let off = 0; off < (count ?? 0); off += 1000) {
  const { data } = await sb.from("push_job_records").select("person_id").eq("push_job_id", SOURCE_JOB).order("person_id").range(off, off + 999);
  for (const r of data) ids.push(r.person_id);
}
const slice = ids.slice(0, TICK);
console.log(`Resolved ${ids.length} person ids; using a ${slice.length}-id tick slice.\n`);

const lookup = (personIds) => sb.from("platform_pushes").select("person_id,platform_contact_id").eq("client_id", CLIENT_ID).eq("platform", "emailbison").in("person_id", personIds);

// ── OLD (buggy) path: one unchunked .in() over the whole tick slice ──────────
console.log("OLD unchunked .in() over", slice.length, "ids:");
const { data: oldData, error: oldErr } = await lookup(slice);
if (oldErr) {
  console.log("  → FAILED (this is the bug)");
  console.log("     instanceof Error :", oldErr instanceof Error);
  console.log("     String(err)      :", String(oldErr), "   ← what got written to push_jobs.error");
} else {
  console.log("  → unexpectedly OK, rows:", oldData.length);
}

// ── NEW (fixed) path: chunked at 200, merged ─────────────────────────────────
console.log("\nNEW chunked .in() at", CHUNK, "ids/chunk:");
const chunks = [];
for (let i = 0; i < slice.length; i += CHUNK) chunks.push(slice.slice(i, i + CHUNK));
const results = await Promise.all(chunks.map((c) => lookup(c)));
const firstErr = results.find((r) => r.error)?.error;
if (firstErr) {
  console.log("  → FAILED:", String(firstErr));
} else {
  const rows = results.flatMap((r) => r.data ?? []);
  console.log(`  → OK across ${chunks.length} chunks, ${rows.length} platform_pushes rows merged.`);
}
