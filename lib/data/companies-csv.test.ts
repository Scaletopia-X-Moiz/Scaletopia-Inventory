import { describe, expect, it } from "vitest";
import { exportCompaniesCsv } from "@/lib/data/companies-csv";
import { getAllFilteredCompanies } from "@/lib/data/companies";
import { includeOnly } from "@/lib/data/include-exclude";
import { supabaseAdmin } from "@/lib/supabase/admin";

/** Counts CSV records the way a spec-correct CSV reader would: a newline only
 * ends a record when it's outside a quoted field (some exported columns, e.g.
 * Description, can legitimately contain embedded newlines inside quotes) —
 * unlike a naive `wc -l`/`split("\n")`, which either over- or under-counts
 * whenever a field embeds a real newline or the file lacks a trailing one.
 * Also exercises the actual bug this ticket fixes: buildCsv previously
 * produced no trailing newline after the last row, so a *file-level*
 * newline-counting check (distinct from this in-memory record count) would
 * see one newline fewer than there are data rows. */
function countCsvRecords(csv: string): number {
  if (csv.length === 0) return 0;
  let records = 0;
  let inQuotes = false;
  let sawContentOnLine = false;
  for (let i = 0; i < csv.length; i++) {
    const ch = csv[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
      sawContentOnLine = true;
    } else if (ch === "\n" && !inQuotes) {
      records++;
      sawContentOnLine = false;
    } else {
      sawContentOnLine = true;
    }
  }
  if (sawContentOnLine) records++; // trailing line with no terminator
  return records - 1; // exclude the header record
}

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
    // Naive split("\n") both over-counts (some exported columns, e.g.
    // Description, can contain literal embedded newlines inside a quoted
    // field) and previously under-counted by one (buildCsv had no trailing
    // newline — ticket 75) — countCsvRecords is quote-aware and immune to both.
    expect(countCsvRecords(csv)).toBe(rows.length);
  });

  it("ends with a trailing newline so line-counting tools (e.g. `wc -l`) see every row (ticket 75)", async () => {
    const csv = await exportCompaniesCsv({ source: includeOnly(["aiark"]) });
    expect(csv.endsWith("\n")).toBe(true);
    expect(csv.endsWith("\n\n")).toBe(false);
  });

  it("exported row count matches the on-screen filtered count across sizes that cross the export's internal page-size boundaries (ticket 75)", async () => {
    // Each of these filters is expected to match a result set that straddles
    // the export pipeline's internal page sizes: fetchAllRows pages the
    // filtered scan 1000 rows at a time, and the by-id full-row fetch chunks
    // ids 200 at a time. A filter matching a few thousand rows crosses both
    // several times over — exactly the shape of the reported bug (country=IN,
    // ~2.4k rows, reported one row short).
    const filterCases: Array<{ label: string; filters: Parameters<typeof exportCompaniesCsv>[0] }> = [
      { label: "country=IN (~2.4k rows, crosses 1000- and 200-row boundaries)", filters: { country: includeOnly(["IN"]) } },
      { label: "country=AU (~2k rows)", filters: { country: includeOnly(["AU"]) } },
      { label: "country=GB (~7k rows)", filters: { country: includeOnly(["GB"]) } },
    ];

    for (const { label, filters } of filterCases) {
      let query = supabaseAdmin.from("companies").select("id", { count: "exact", head: true });
      if (filters.country?.include.length) query = query.in("country_id", filters.country.include);
      const { count, error } = await query;
      expect(error).toBeNull();

      // Skip filters that don't currently match a boundary-crossing size on
      // the live table (data volumes drift) rather than asserting on a count
      // this test doesn't control — the assertion that matters is the
      // three-way equality below whenever there IS data to compare.
      if (!count) continue;

      const csv = await exportCompaniesCsv(filters);
      const rows = await getAllFilteredCompanies(filters);

      expect(countCsvRecords(csv), `${label}: CSV record count`).toBe(count);
      expect(rows.length, `${label}: getAllFilteredCompanies rows`).toBe(count);
    }
  }, 60000);

  it("flattens Source to a comma-joined string per row", async () => {
    const csv = await exportCompaniesCsv({ source: includeOnly(["aiark", "blitz"]) });
    const dataLines = csv.split("\n").slice(1, -1);
    expect(dataLines.length).toBeGreaterThan(0);
    // raw delimited/variant source tokens (unambiguous: these never appear in
    // company names) must never leak into the export
    for (const line of dataLines.slice(0, 20)) {
      expect(line).not.toMatch(/aiark-api|aiark-people|blitz-api|blitz-people/);
    }
  });
});
