import { describe, expect, it } from "vitest";
import { exportPeopleCsv } from "@/lib/data/people-csv";
import { getAllFilteredPeople } from "@/lib/data/people";
import { includeOnly } from "@/lib/data/include-exclude";

describe("exportPeopleCsv", () => {
  it("has exactly the visible table columns, in order", async () => {
    const csv = await exportPeopleCsv({ source: includeOnly(["aiark"]) });
    const [header] = csv.split("\n");
    expect(header).toBe("Full Name,Job Title,Email,Email Status,Phone,Phone Type,Company,City,State,Country,Source,Last Updated");
  });

  it("row count matches the same filtered query used by the table", async () => {
    const filters = { emailStatus: includeOnly(["ok"]) };
    const rows = await getAllFilteredPeople(filters);
    const csv = await exportPeopleCsv(filters);
    const lines = csv.split("\n");
    expect(lines.length - 1).toBe(rows.length);
  });

  it("flattens Source to a comma-joined string per row", async () => {
    const csv = await exportPeopleCsv({ source: includeOnly(["aiark", "blitz"]) });
    const dataLines = csv.split("\n").slice(1);
    expect(dataLines.length).toBeGreaterThan(0);
    for (const line of dataLines.slice(0, 20)) {
      expect(line).not.toMatch(/aiark-people|blitz-people|aiark-api|blitz-api/);
    }
  });
});
