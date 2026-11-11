/**
 * Sync the `clients` table from Airtable's Locations table
 * (lib/clients/location-sync-plan.ts has the rules).
 *
 *   npx tsx scripts/sync-clients-from-airtable.ts            # dry run: print the plan
 *   npx tsx scripts/sync-clients-from-airtable.ts --apply    # write it
 *   ... --apply --backup-dir <dir>                           # also save a revert file there
 *
 * Needs SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and AIRTABLE_TOKEN (env or
 * .env.local). Never prints a key. The app runs the same sync from the
 * "Sync from Airtable" button on /clients and from the hourly cron
 * /api/internal/clients-sync.
 *
 * Revert: the backup file lists the inserted row ids (delete them) and the
 * filled columns (set them back to NULL; they were NULL before).
 */
import { config } from "dotenv";
config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "@supabase/supabase-js";
import { planClientSync } from "../lib/clients/location-sync-plan";
import { applySyncPlan, loadSyncInputs } from "../lib/clients/location-sync";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const backupDir = arg("--backup-dir");
  const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, AIRTABLE_TOKEN } = process.env;
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set");
  if (!AIRTABLE_TOKEN) throw new Error("AIRTABLE_TOKEN must be set");

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
  const plan = planClientSync(await loadSyncInputs({ supabase, airtableToken: AIRTABLE_TOKEN }));

  console.log(`Already linked (${plan.linked.length}): ${plan.linked.join(", ") || "-"}`);
  console.log(`\nWill insert (${plan.inserts.length}):`);
  for (const i of plan.inserts) {
    console.log(
      `  + ${i.name} [${i.slug}] ghl=${i.ghlLocationId ?? "-"} emailbison=${i.emailbisonApiKey ? "yes" : "no"} (${i.source})`
    );
  }
  console.log(`\nWill fill empty credentials (${plan.fills.length}):`);
  for (const f of plan.fills) {
    const what = [f.ghlApiKey && "GHL key", f.emailbisonApiKey && "EmailBison key + base URL"].filter(Boolean).join(", ");
    console.log(`  ~ ${f.clientName}: ${what} (${f.source})`);
  }
  console.log(`\nNeeds a human (${plan.notes.length}):`);
  for (const n of plan.notes) console.log(`  ! [${n.kind}] ${n.name}: ${n.detail}`);

  if (!apply) {
    console.log("\nDry run. Re-run with --apply to write.");
    return;
  }

  const result = await applySyncPlan(supabase, plan);
  console.log(`\nInserted ${result.inserted.length}, filled ${result.filled.length}.`);
  if (backupDir) {
    mkdirSync(backupDir, { recursive: true });
    const file = join(backupDir, `clients-sync-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(
      file,
      JSON.stringify(
        {
          revert: "DELETE FROM clients WHERE id IN (inserted ids); for each filled row set the listed columns back to NULL",
          inserted: result.inserted,
          filled: result.filled,
        },
        null,
        2
      )
    );
    console.log(`Revert file: ${file}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
