import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });

import { it } from "vitest";
import { getPeopleForEmailBisonByCompanyFilters } from "@/lib/data/people";
import { includeOnly } from "@/lib/data/include-exclude";

it(
  "perf probe: companies-side EmailBison push resolution over the QA set",
  async () => {
    const filters = { source: includeOnly(["claude-qa-2026-08"]) };

    const t0 = Date.now();
    const candidates = await getPeopleForEmailBisonByCompanyFilters(filters);
    const elapsed = Date.now() - t0;

    console.log(
      `Resolved ${candidates.length} EmailBison push candidates (companies filter: source=claude-qa-2026-08).`
    );
    console.log(`Elapsed: ${elapsed}ms`);
    console.log("\nSample record (first candidate):");
    console.log(JSON.stringify(candidates[0]?.record, null, 2));
  },
  120000
);
