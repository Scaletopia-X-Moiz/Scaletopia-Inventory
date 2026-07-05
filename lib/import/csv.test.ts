import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCSV, applyColumnMap } from "@/lib/import/csv";
import { normalizeDomain, normalizeLinkedInUrl, scrubJunkDomain, dedupeCompanies, dedupePeople } from "@/lib/import/normalize";
import { BUILTIN_PROVIDERS, COMPANIES_FIELDS, PEOPLE_FIELDS } from "@/lib/import/providers";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "__fixtures__", name), "utf8");

// ─── parseCSV ────────────────────────────────────────────────────────────────

describe("parseCSV", () => {
  it("parses basic CSV with correct headers and row count", () => {
    const csv = "Name,Website\nAcme,https://acme.com\nBeta,https://beta.io";
    const { headers, rows } = parseCSV(csv);
    expect(headers).toEqual(["Name", "Website"]);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ Name: "Acme", Website: "https://acme.com" });
  });

  it("handles quoted fields containing commas", () => {
    const csv = `Name,City\n"Acme, Inc",Austin`;
    const { rows } = parseCSV(csv);
    expect(rows[0].Name).toBe("Acme, Inc");
    expect(rows[0].City).toBe("Austin");
  });

  it("handles escaped double-quotes inside quoted fields", () => {
    const csv = `Name\n"Has ""Quotes"" Inside"`;
    const { rows } = parseCSV(csv);
    expect(rows[0].Name).toBe('Has "Quotes" Inside');
  });

  it("handles Windows \\r\\n line endings", () => {
    const csv = "Name,Website\r\nAcme,https://acme.com\r\nBeta,https://beta.io";
    const { rows } = parseCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0].Name).toBe("Acme");
  });

  it("ignores blank lines", () => {
    const csv = "Name,Website\n\nAcme,https://acme.com\n\n";
    const { rows } = parseCSV(csv);
    expect(rows).toHaveLength(1);
  });

  it("returns empty result for empty string", () => {
    const { headers, rows } = parseCSV("");
    expect(headers).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("returns empty result for whitespace-only string", () => {
    const { headers, rows } = parseCSV("   \n  \n");
    expect(headers).toEqual([]);
    expect(rows).toEqual([]);
  });

  it("fills missing trailing cells with empty string", () => {
    const csv = "A,B,C\n1,2";
    const { rows } = parseCSV(csv);
    expect(rows[0].C).toBe("");
  });

  it("header-only CSV (no data rows) returns empty rows array", () => {
    const { headers, rows } = parseCSV("Name,Website");
    expect(headers).toEqual(["Name", "Website"]);
    expect(rows).toHaveLength(0);
  });

  it("handles multi-line quoted fields without splitting them into extra rows", () => {
    const csv =
      `"Company Name","Count","Description"\n` +
      `"Acme Corp","100","Line one\n\nLine two\n\nLine three"` +
      `\n"Beta LLC","50","Normal"`;
    const { rows } = parseCSV(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]["Company Name"]).toBe("Acme Corp");
    expect(rows[0]["Description"]).toBe("Line one\n\nLine two\n\nLine three");
    expect(rows[1]["Company Name"]).toBe("Beta LLC");
  });
});

// ─── applyColumnMap ──────────────────────────────────────────────────────────

describe("applyColumnMap", () => {
  const rows = [
    { Company: "Acme", Website: "https://acme.com", Notes: "skip me" },
    { Company: "Beta", Website: "", Notes: "also skip" },
  ];

  it("maps CSV headers to supabase fields", () => {
    const result = applyColumnMap(rows, { Company: "company_name", Website: "website_url" });
    expect(result[0]).toEqual({ company_name: "Acme", website_url: "https://acme.com" });
  });

  it("omits empty string values from output", () => {
    const result = applyColumnMap(rows, { Company: "company_name", Website: "website_url" });
    expect(result[1]).not.toHaveProperty("website_url");
  });

  it('skips columns mapped to "ignore"', () => {
    const result = applyColumnMap(rows, { Company: "company_name", Notes: "ignore" });
    expect(result[0]).not.toHaveProperty("Notes");
    expect(result[0]).not.toHaveProperty("ignore");
  });

  it("skips columns mapped to empty string", () => {
    const result = applyColumnMap(rows, { Company: "company_name", Notes: "" });
    expect(result[0]).not.toHaveProperty("Notes");
  });

  it("skips CSV headers not present in the column map", () => {
    const result = applyColumnMap(rows, { Company: "company_name" });
    expect(result[0]).not.toHaveProperty("Website");
    expect(result[0]).not.toHaveProperty("Notes");
  });

  it("bundles multiple custom_data columns into a single object keyed by CSV header", () => {
    const customRows = [{ Facebook: "fb.com/acme", Twitter: "@acme", Domain: "acme.com" }];
    const result = applyColumnMap(customRows, {
      Facebook: "custom_data",
      Twitter: "custom_data",
      Domain: "domain",
    });
    expect(result[0].custom_data).toEqual({ Facebook: "fb.com/acme", Twitter: "@acme" });
    expect(result[0].domain).toBe("acme.com");
  });

  it("omits custom_data key entirely when all mapped columns are empty", () => {
    const customRows = [{ Facebook: "", Twitter: "", Domain: "acme.com" }];
    const result = applyColumnMap(customRows, {
      Facebook: "custom_data",
      Twitter: "custom_data",
      Domain: "domain",
    });
    expect(result[0]).not.toHaveProperty("custom_data");
  });

  it("includes only non-empty values in custom_data object", () => {
    const customRows = [{ Facebook: "fb.com/acme", Twitter: "", Domain: "acme.com" }];
    const result = applyColumnMap(customRows, {
      Facebook: "custom_data",
      Twitter: "custom_data",
      Domain: "domain",
    });
    expect(result[0].custom_data).toEqual({ Facebook: "fb.com/acme" });
    expect((result[0].custom_data as Record<string, string>).Twitter).toBeUndefined();
  });

  it("drops rows with no identity fields (domain, linkedin_url, company_name, full_name, first_name)", () => {
    const junkRows = [
      { Notes: "nothing useful", Industry: "Tech" },
      { Company: "Acme", Notes: "has a name" },
    ];
    const result = applyColumnMap(junkRows, {
      Notes: "notes",
      Industry: "industry",
      Company: "company_name",
    });
    expect(result).toHaveLength(1);
    expect(result[0].company_name).toBe("Acme");
  });

  it("normalizes a colon-separated company email list to comma-separated", () => {
    const emailRows = [
      { Domain: "acme.com", Emails: "care@acme.com:support@acme.com:hello@acme.com" },
    ];
    const result = applyColumnMap(emailRows, { Domain: "domain", Emails: "email" });
    expect(result[0].email).toBe("care@acme.com, support@acme.com, hello@acme.com");
  });

  it("leaves a single company email untouched", () => {
    const emailRows = [{ Domain: "acme.com", Emails: "hello@acme.com" }];
    const result = applyColumnMap(emailRows, { Domain: "domain", Emails: "email" });
    expect(result[0].email).toBe("hello@acme.com");
  });

  it("normalizes semicolon- and comma-separated company emails too", () => {
    const emailRows = [{ Domain: "acme.com", Emails: "a@acme.com; b@acme.com , c@acme.com" }];
    const result = applyColumnMap(emailRows, { Domain: "domain", Emails: "email" });
    expect(result[0].email).toBe("a@acme.com, b@acme.com, c@acme.com");
  });

  it("keeps rows that have only one identity field present", () => {
    const sparseRows = [{ Email: "x@y.com", LinkedInURL: "https://linkedin.com/in/x" }];
    const result = applyColumnMap(sparseRows, {
      Email: "email",
      LinkedInURL: "linkedin_url",
    });
    expect(result).toHaveLength(1);
    expect(result[0].linkedin_url).toBe("https://linkedin.com/in/x");
  });
});

// ─── fixture: apollo companies ───────────────────────────────────────────────

describe("fixture: apollo-companies.csv", () => {
  const apolloProvider = BUILTIN_PROVIDERS.find((p) => p.sourceKey === "apollo")!;

  it("parses correct number of data rows", () => {
    const { rows } = parseCSV(fixture("apollo-companies.csv"));
    expect(rows).toHaveLength(4);
  });

  it("maps apollo columns to supabase fields", () => {
    const { rows } = parseCSV(fixture("apollo-companies.csv"));
    const mapped = applyColumnMap(rows, apolloProvider.columnMap);
    expect(mapped[0].company_name).toBe("Acme Corp");
    expect(mapped[0].website_url).toBe("https://www.acme.com");
    expect(mapped[0].linkedin_url).toBe("https://www.linkedin.com/company/acme/");
    expect(mapped[0].employee_count).toBe("250");
  });

  it("handles quoted company name with comma (Beta, LLC)", () => {
    const { rows } = parseCSV(fixture("apollo-companies.csv"));
    const mapped = applyColumnMap(rows, apolloProvider.columnMap);
    expect(mapped[1].company_name).toBe("Beta, LLC");
  });

  it("normalizes domains correctly after mapping", () => {
    const { rows } = parseCSV(fixture("apollo-companies.csv"));
    const mapped = applyColumnMap(rows, apolloProvider.columnMap);

    const normalized = mapped.map((r) => ({
      ...r,
      domain: scrubJunkDomain(normalizeDomain(r.website_url as string)),
      linkedin_url: normalizeLinkedInUrl(r.linkedin_url as string),
    }));

    expect(normalized[0].domain).toBe("acme.com");
    expect(normalized[1].domain).toBe("beta.io");
    expect(normalized[2].domain).toBe("gamma.co");
    // Delta Co's website is facebook.com — should be scrubbed to null
    expect(normalized[3].domain).toBeNull();
  });

  it("dedupes correctly — 4 input rows → 4 unique (no duplicates in fixture)", () => {
    const { rows } = parseCSV(fixture("apollo-companies.csv"));
    const mapped = applyColumnMap(rows, apolloProvider.columnMap);
    const normalized = mapped.map((r) => ({
      ...r,
      domain: scrubJunkDomain(normalizeDomain(r.website_url as string)),
    }));
    const deduped = dedupeCompanies(normalized);
    expect(deduped).toHaveLength(4);
  });
});

// ─── fixture: salesnav people ────────────────────────────────────────────────

describe("fixture: salesnav-people.csv", () => {
  const salesNavProvider = BUILTIN_PROVIDERS.find((p) => p.sourceKey === "salesnav")!;

  it("parses 3 raw rows (including the duplicate)", () => {
    const { rows } = parseCSV(fixture("salesnav-people.csv"));
    expect(rows).toHaveLength(3);
  });

  it("maps to correct people fields", () => {
    const { rows } = parseCSV(fixture("salesnav-people.csv"));
    const mapped = applyColumnMap(rows, salesNavProvider.columnMap);
    expect(mapped[0].full_name).toBe("Jane Smith");
    expect(mapped[0].job_title).toBe("VP of Sales");
    expect(mapped[0].linkedin_url).toBe("https://www.linkedin.com/in/jane-smith/");
  });

  it("omits empty email field", () => {
    const { rows } = parseCSV(fixture("salesnav-people.csv"));
    const mapped = applyColumnMap(rows, salesNavProvider.columnMap);
    // John Doe has no email in fixture
    expect(mapped[1]).not.toHaveProperty("email");
  });

  it("dedupes duplicate Jane Smith row → 2 unique people", () => {
    const { rows } = parseCSV(fixture("salesnav-people.csv"));
    const mapped = applyColumnMap(rows, salesNavProvider.columnMap);
    const normalized = mapped.map((r) => ({
      ...r,
      linkedin_url: normalizeLinkedInUrl(r.linkedin_url as string),
    }));
    const deduped = dedupePeople(normalized);
    expect(deduped).toHaveLength(2);
  });
});

// ─── fixture: manual-companies.csv (edge cases) ──────────────────────────────

describe("fixture: manual-companies.csv", () => {
  it("handles quoted field with comma", () => {
    const { rows } = parseCSV(fixture("manual-companies.csv"));
    expect(rows[0]["Company Name"]).toBe("Quoted, Co");
  });

  it("handles escaped double-quotes in field", () => {
    const { rows } = parseCSV(fixture("manual-companies.csv"));
    expect(rows[1]["Company Name"]).toBe('Has "Escaped" Quotes Inc');
  });

  it("parses 3 data rows total", () => {
    const { rows } = parseCSV(fixture("manual-companies.csv"));
    expect(rows).toHaveLength(3);
  });
});

// ─── BUILTIN_PROVIDERS sanity check ──────────────────────────────────────────

describe("BUILTIN_PROVIDERS column maps", () => {
  const validFields = new Set([...COMPANIES_FIELDS, ...PEOPLE_FIELDS, "ignore"]);

  for (const provider of BUILTIN_PROVIDERS) {
    it(`${provider.sourceKey}: all mapped values are valid fields or "ignore"`, () => {
      for (const [csvHeader, field] of Object.entries(provider.columnMap)) {
        expect(
          validFields.has(field),
          `Provider "${provider.sourceKey}" maps "${csvHeader}" → "${field}" which is not a known field`
        ).toBe(true);
      }
    });
  }
});
