import { config } from "dotenv";
config({ path: "D:/Scaletopia/Scaletopia-Inventory/.env.local" });

import { it } from "vitest";
import { getEmailBisonCompanyNameFieldsByCompanyFilters } from "@/lib/data/people";
import { getCompanyEnrichmentFields } from "@/lib/data/enrichment-fields";
import { includeOnly } from "@/lib/data/include-exclude";

it(
  "perf probe: Options-step endpoints (default-field-mapping + enrichment-fields) over the QA companies set",
  async () => {
    const filters = { source: includeOnly(["claude-qa-2026-08"]) };

    const t0 = Date.now();
    const nameFields = await getEmailBisonCompanyNameFieldsByCompanyFilters(filters);
    const t1 = Date.now();
    const enrichment = await getCompanyEnrichmentFields(filters);
    const t2 = Date.now();

    console.log(`default-field-mapping (brand-name existence check): ${t1 - t0}ms, sentinel length=${nameFields.length}`);
    console.log(`enrichment-fields: ${t2 - t1}ms, fields found=${enrichment.fields.length}, sampledRows=${enrichment.sampledRows}`);
    console.log(`Combined (parallel in the real dialog, so actual wall time ~= max, not sum): ${t2 - t0}ms sequential`);
  },
  60000
);
