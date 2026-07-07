import { describe, expect, it } from "vitest";
import { exportCompaniesCsv } from "@/lib/data/companies-csv";
import { getAllFilteredCompanies } from "@/lib/data/companies";
import { includeOnly } from "@/lib/data/include-exclude";

describe("exportCompaniesCsv", () => {
  it("has exactly the visible table columns, in order", async () => {
    const csv = await exportCompaniesCsv({ source: includeOnly(["aiark"]) });
    const [header] = csv.split("\n");
    expect(header).toBe(
      "Company Name,Domain,Website URL,LinkedIn URL,Niche,Industry,Employees,City,State,Country,Phone,Source,Quality Tier,Last Updated"
    );
  });

  it("row count matches the same filtered query used by the table", async () => {
    const filters = { employeeBucket: ["1-10"] };
    const rows = await getAllFilteredCompanies(filters);
    const csv = await exportCompaniesCsv(filters);
    const lines = csv.split("\n");
    expect(lines.length - 1).toBe(rows.length);
  });

  it("flattens Source to a comma-joined string per row", async () => {
    const csv = await exportCompaniesCsv({ source: includeOnly(["aiark", "blitz"]) });
    const dataLines = csv.split("\n").slice(1);
    expect(dataLines.length).toBeGreaterThan(0);
    // raw delimited/variant source tokens (unambiguous: these never appear in
    // company names) must never leak into the export
    for (const line of dataLines.slice(0, 20)) {
      expect(line).not.toMatch(/aiark-api|aiark-people|blitz-api|blitz-people/);
    }
  });
});
