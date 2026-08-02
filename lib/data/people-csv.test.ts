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
    // buildCsv terminates every line with "\n" (including the last row — see
    // ticket 75), so splitting leaves a trailing empty string after it.
    const lines = csv.split("\n").slice(0, -1);
    expect(lines.length - 1).toBe(rows.length);
  });

  it("ends with a trailing newline so line-counting tools (e.g. `wc -l`) see every row (ticket 75)", async () => {
    const csv = await exportPeopleCsv({ source: includeOnly(["aiark"]) });
    expect(csv.endsWith("\n")).toBe(true);
    expect(csv.endsWith("\n\n")).toBe(false);
  });

  it("flattens Source to a comma-joined string per row", async () => {
    const csv = await exportPeopleCsv({ source: includeOnly(["aiark", "blitz"]) });
    const dataLines = csv.split("\n").slice(1, -1);
    expect(dataLines.length).toBeGreaterThan(0);
    for (const line of dataLines.slice(0, 20)) {
      expect(line).not.toMatch(/aiark-people|blitz-people|aiark-api|blitz-api/);
    }
  });
});
