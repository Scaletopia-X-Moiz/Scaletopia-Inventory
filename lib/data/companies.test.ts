import { describe, expect, it } from "vitest";
import {
  getCompanies,
  getCompanyDetail,
  getCompanyFilterOptions,
  getAllFilteredCompanies,
} from "@/lib/data/companies";
import { includeOnly } from "@/lib/data/include-exclude";

describe("getCompanyFilterOptions", () => {
  it("returns normalized, deduped options for every filter dimension", async () => {
    const options = await getCompanyFilterOptions();

    expect(options.niches.length).toBeGreaterThan(0);
    expect(options.sources.length).toBeGreaterThan(0);
    expect(options.industries.length).toBeGreaterThan(0);
    expect(options.countries.length).toBeGreaterThan(0);
    expect(options.employeeBuckets).toHaveLength(5);

    // country synonyms collapse: US/United States/united states -> one entry
    const us = options.countries.filter((c) => c.id === "US");
    expect(us).toHaveLength(1);
    expect(us[0].label).toBe("United States");

    // source ids are canonical, never raw delimited/variant strings
    for (const s of options.sources) {
      expect(s.id).not.toMatch(/[,&]/);
    }
  });
});

describe("getCompanies", () => {
  it("returns paginated results with a total count", async () => {
    const result = await getCompanies({}, 1, 25);
    expect(result.rows).toHaveLength(25);
    expect(result.total).toBeGreaterThan(25);
    expect(result.page).toBe(1);
  });

  it("page rows carry full display columns via the by-id refetch", async () => {
    // getCompanies scans a narrow filter-column set for the full table, then
    // refetches display columns only for the visible page by id. The paged
    // rows must be byte-identical to the full-scan path (getAllFilteredCompanies)
    // for both identity/order and the display-only columns dropped from the scan.
    const all = await getAllFilteredCompanies({});
    const page = await getCompanies({}, 1, 25);

    expect(page.rows.map((r) => r.id)).toEqual(all.slice(0, 25).map((r) => r.id));

    for (let i = 0; i < page.rows.length; i++) {
      const p = page.rows[i];
      const a = all[i];
      // display-only columns absent from the narrow filter scan
      expect(p.companyName).toBe(a.companyName);
      expect(p.brandName).toBe(a.brandName);
      expect(p.domain).toBe(a.domain);
      expect(p.websiteUrl).toBe(a.websiteUrl);
      expect(p.linkedinUrl).toBe(a.linkedinUrl);
      expect(p.city).toBe(a.city);
      expect(p.state).toBe(a.state);
      expect(p.qualityTier).toBe(a.qualityTier);
      expect(p.phoneStatus).toBe(a.phoneStatus);
      // filter columns still present and correct
      expect(p.niche).toBe(a.niche);
      expect(p.employeeCount).toBe(a.employeeCount);
      expect(p.sources).toEqual(a.sources);
    }
  });

  it("search filters by name or domain substring", async () => {
    const first = await getAllFilteredCompanies({});
    const sample = first[0];
    const term = (sample.companyName ?? sample.domain ?? "").slice(0, 4);
    if (!term) return;

    const result = await getCompanies({ search: term }, 1, 1000);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      const haystack = `${row.companyName ?? ""} ${row.domain ?? ""}`.toLowerCase();
      expect(haystack).toContain(term.toLowerCase());
    }
  });

  it("niche filter returns only companies with that niche", async () => {
    const options = await getCompanyFilterOptions();
    const niche = options.niches[0];

    const result = await getCompanies({ niche: includeOnly([niche.id]) }, 1, 1000);
    expect(result.total).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.niche).toBe(niche.id);
    }
  });

  it("niche exclude filter removes companies with that niche", async () => {
    const options = await getCompanyFilterOptions();
    const niche = options.niches[0];

    const all = await getCompanies({}, 1, 1000);
    const result = await getCompanies({ niche: { include: [], exclude: [niche.id] } }, 1, 1000);
    expect(result.total).toBeLessThan(all.total);
    for (const row of result.rows) {
      expect(row.niche).not.toBe(niche.id);
    }
  });

  it("source filter matches normalized tokens regardless of raw variant", async () => {
    const result = await getCompanies({ source: includeOnly(["aiark"]) }, 1, 1000);
    expect(result.total).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.sources).toContain("aiark");
    }
  });

  it("employee size buckets exclude null employee_count and respect ranges", async () => {
    const result = await getCompanies({ employeeBucket: ["1-10"] }, 1, 1000);
    expect(result.total).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.employeeCount).not.toBeNull();
      expect(row.employeeCount as number).toBeGreaterThanOrEqual(1);
      expect(row.employeeCount as number).toBeLessThanOrEqual(10);
    }
  });

  it("country filter collapses synonyms (US/United States/united states)", async () => {
    const result = await getCompanies({ country: includeOnly(["US"]) }, 1, 1000);
    expect(result.total).toBeGreaterThan(0);
  });

  it("industry filter matches case-insensitively", async () => {
    const options = await getCompanyFilterOptions();
    const industry = options.industries.find((i) => i.count > 0);
    expect(industry).toBeDefined();

    const result = await getCompanies({ industry: includeOnly([industry!.id]) }, 1, 1000);
    expect(result.total).toBeGreaterThan(0);
    // Every returned row must normalize to the requested industry id
    for (const row of result.rows) {
      expect(row.industry?.trim().toLowerCase()).toBe(industry!.id);
    }
  });

  it("industry exclude filter removes companies in that industry", async () => {
    const options = await getCompanyFilterOptions();
    const industry = options.industries.find((i) => i.count > 0);
    expect(industry).toBeDefined();

    const all = await getCompanies({}, 1, 1000);
    const result = await getCompanies(
      { industry: { include: [], exclude: [industry!.id] } },
      1,
      1000
    );
    expect(result.total).toBeLessThan(all.total);
    for (const row of result.rows) {
      expect(row.industry?.trim().toLowerCase()).not.toBe(industry!.id);
    }
  });

  it("combines multiple filters with AND semantics", async () => {
    const broad = await getCompanies({ source: includeOnly(["aiark"]) }, 1, 1000);
    const narrowed = await getCompanies(
      { source: includeOnly(["aiark"]), employeeBucket: ["1-10"] },
      1,
      1000
    );
    expect(narrowed.total).toBeLessThanOrEqual(broad.total);
  });

  it("include and exclude on the same facet compose (exclude wins for overlapping ids)", async () => {
    const options = await getCompanyFilterOptions();
    const [nicheA, nicheB] = options.niches;
    expect(nicheB).toBeDefined();

    const result = await getCompanies(
      { niche: { include: [nicheA.id, nicheB.id], exclude: [nicheB.id] } },
      1,
      1000
    );
    expect(result.total).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.niche).toBe(nicheA.id);
    }
  });
});

describe("getCompanyDetail", () => {
  it("returns full detail with tags as-is and blocklisted custom_data stripped", async () => {
    // Use source filter to avoid picking up test-inserted records (which sort
    // to the top by last_updated and may be deleted before this assertion runs).
    const list = await getCompanies({ source: includeOnly(["aiark"]) }, 1, 1);
    const id = list.rows[0].id;

    const detail = await getCompanyDetail(id);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(id);
    expect(Array.isArray(detail!.tags)).toBe(true);

    for (const blocked of ["naics", "aiark_id", "industries", "legal_name", "created_at", "updated_at"]) {
      expect(detail!.customData).not.toHaveProperty(blocked);
    }
    for (const key of Object.keys(detail!.customData)) {
      expect(key.startsWith("pushed_to_")).toBe(false);
      expect(key.endsWith("_at")).toBe(false);
    }
  });

  it("returns null for a non-existent id", async () => {
    const detail = await getCompanyDetail("00000000-0000-0000-0000-000000000000");
    expect(detail).toBeNull();
  });
});
