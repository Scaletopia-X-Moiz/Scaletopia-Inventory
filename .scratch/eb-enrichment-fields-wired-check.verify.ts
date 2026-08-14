import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });

import { it, expect } from "vitest";
import { getCompanyEnrichmentFields } from "@/lib/data/enrichment-fields";

it(
  "enrichment-fields mechanism actually returns real fields against the full (non-QA) companies table",
  async () => {
    const result = await getCompanyEnrichmentFields({});
    console.log(`Unfiltered companies enrichment discovery: ${result.fields.length} fields, sampledRows=${result.sampledRows}`);
    console.log(JSON.stringify(result.fields.slice(0, 8), null, 2));
    expect(result.fields.length).toBeGreaterThan(0);
  },
  30000
);
