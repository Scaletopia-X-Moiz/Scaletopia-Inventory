import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });

const { getEmailBisonCompanyNameFields, getPeopleForGhl } = await import("../lib/data/people");
const { getPersonEnrichmentFields } = await import("../lib/data/enrichment-fields");
import type { PersonListFilters } from "../lib/data/people";

// Mirrors what /people?source=claude-qa-2026-08 resolves to (~10,400 rows).
const filters: PersonListFilters = {
  source: { include: ["claude-qa-2026-08"], exclude: [] },
};

async function time<T>(label: string, fn: () => Promise<T>): Promise<T> {
  const start = Date.now();
  const result = await fn();
  const ms = Date.now() - start;
  console.log(`${label}: ${ms}ms`);
  return result;
}

async function main() {
  console.log("=== EmailBison dialog's Options step (real route logic) ===");
  // Mirrors GET /api/emailbison/default-field-mapping?entity=people — the
  // existence-check-optimized path from commit c0beb10 (untouched by this
  // audit's edits).
  const ebRecords = await time("getEmailBisonCompanyNameFields (existence check)", () =>
    getEmailBisonCompanyNameFields(filters)
  );
  console.log(`  -> resolved to ${ebRecords.length} sentinel row(s) (0 or 1, by design)`);

  await time("getPersonEnrichmentFields (bounded 500-row sample RPC)", () =>
    getPersonEnrichmentFields(filters)
  );

  console.log("\n=== GHL dialog's Options/mapping step (real route logic) ===");
  // Mirrors POST /api/people/push-to-ghl/default-mapping — this route calls
  // getPeopleForGhl directly (a full per-record resolve, not an existence
  // check like EmailBison's route) — this predates this audit; confirming it
  // still completes in low seconds against ~10,400 rows despite the widened
  // FULL_ROW_COLUMNS select (this audit + the parallel companies-side audit
  // both added company* columns to that shared select).
  const ghlCandidates = await time("getPeopleForGhl (full per-record resolve, ~10,400 rows)", () =>
    getPeopleForGhl(filters)
  );
  console.log(`  -> resolved ${ghlCandidates.length} GHL push candidates`);

  // Spot-check: confirm a resolved GHL candidate actually carries the new
  // fields with real values (not just present-but-null).
  const withState = ghlCandidates.find((c) => c.record.state);
  const withCompanyDomainStatus = ghlCandidates.find((c) => c.record.companyDomainStatus);
  console.log(
    `  sample state="${withState?.record.state}" companyDomainStatus="${withCompanyDomainStatus?.record.companyDomainStatus}"`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
