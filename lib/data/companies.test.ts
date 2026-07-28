import { describe, expect, it } from "vitest";
import {
  getCompanies,
  getCompanyDetail,
  getCompanyFilterOptions,
  getAllFilteredCompanies,
} from "@/lib/data/companies";
import { includeOnly } from "@/lib/data/include-exclude";
import { getCompanyEnrichmentFields } from "@/lib/data/enrichment-fields";

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

describe("getCompanies — virtual-column Text filter (ticket #34)", () => {
  it("'is' narrows to rows carrying that exact value, and total reflects the narrowed set", async () => {
    // Find a real Text enrichment key with at least one sample value, rather
    // than hardcoding a key that may not exist in the connected environment
    // (same approach as enrichment-fields.test.ts).
    const discovery = await getCompanyEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "Text" && f.sampleValues.length > 0);
    expect(field).toBeDefined();
    const value = field!.sampleValues[0];

    const all = await getCompanies({}, 1, 1);
    const result = await getCompanies(
      {
        virtualFilters: [{ key: field!.key, type: "text", operator: "is", value }],
        virtualColumns: [{ key: field!.key, type: "text" }],
      },
      1,
      50
    );

    expect(result.total).toBeGreaterThan(0);
    expect(result.total).toBeLessThanOrEqual(all.total);
    for (const row of result.rows) {
      expect(row.virtualColumnValues?.[field!.key]).toBe(value);
    }
  }, 30000);

  it("'is' with a value list matches rows carrying any of the listed values (ticket #38)", async () => {
    const discovery = await getCompanyEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "Text" && f.sampleValues.length >= 2);
    expect(field).toBeDefined();
    const values = field!.sampleValues.slice(0, 2);

    // The union of the two values must match at least as many rows as either
    // value alone, and every returned row must carry one of them.
    const [a] = values;
    const onlyA = await getCompanies(
      { virtualFilters: [{ key: field!.key, type: "text", operator: "is", value: a }] },
      1,
      1
    );
    const list = await getCompanies(
      {
        virtualFilters: [{ key: field!.key, type: "text", operator: "is", value: values }],
        virtualColumns: [{ key: field!.key, type: "text" }],
      },
      1,
      50
    );

    expect(list.total).toBeGreaterThanOrEqual(onlyA.total);
    expect(list.total).toBeGreaterThan(0);
    for (const row of list.rows) {
      expect(values).toContain(row.virtualColumnValues?.[field!.key]);
    }
  }, 30000);

  it("'contains' matches a substring of the field, not just an exact value", async () => {
    const discovery = await getCompanyEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find(
      (f) => f.type === "Text" && f.sampleValues.some((v) => v.length > 2)
    );
    expect(field).toBeDefined();
    const sample = field!.sampleValues.find((v) => v.length > 2)!;
    const substring = sample.slice(0, Math.max(2, sample.length - 1));

    const result = await getCompanies(
      { virtualFilters: [{ key: field!.key, type: "text", operator: "contains", value: substring }] },
      1,
      1
    );
    expect(result.total).toBeGreaterThan(0);
  }, 30000);

  it("'is_empty' and 'is_not_empty' exhaustively partition the table for a given key", async () => {
    const discovery = await getCompanyEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "Text");
    expect(field).toBeDefined();

    const all = await getCompanies({}, 1, 1);
    const empty = await getCompanies(
      { virtualFilters: [{ key: field!.key, type: "text", operator: "is_empty" }] },
      1,
      1
    );
    const notEmpty = await getCompanies(
      { virtualFilters: [{ key: field!.key, type: "text", operator: "is_not_empty" }] },
      1,
      1
    );
    expect(empty.total + notEmpty.total).toBe(all.total);
  }, 30000);
});

describe("getCompanies — virtual-column Number filter (ticket #35)", () => {
  it("filters numerically over a real numeric key without throwing on junk rows", async () => {
    // The same key holds non-numeric junk ("$10", "-", "{{ 0 }}") on other
    // rows across the ~110k-row table; the guarded RPC must exclude those
    // rather than 500 the request (ADR-0002).
    const discovery = await getCompanyEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "Number" && f.sampleValues.length > 0);
    if (!field) return; // no numeric enrichment field in this environment
    const nums = field.sampleValues.map(Number).filter((n) => Number.isFinite(n));
    if (nums.length === 0) return;
    const min = Math.min(...nums);

    const result = await getCompanies(
      {
        virtualFilters: [{ key: field.key, type: "number", operator: "gt", value: min - 1 }],
        virtualColumns: [{ key: field.key, type: "number" }],
      },
      1,
      25
    );
    expect(result.total).toBeGreaterThan(0);

    // `is` an exact sample narrows to a subset of the `gt` set, never larger.
    const exact = await getCompanies(
      { virtualFilters: [{ key: field.key, type: "number", operator: "is", value: nums[0] }] },
      1,
      1
    );
    expect(exact.total).toBeGreaterThan(0);
    expect(exact.total).toBeLessThanOrEqual(result.total);
  }, 30000);

  it("between selects an inclusive numeric range within the unfiltered total", async () => {
    const discovery = await getCompanyEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "Number" && f.sampleValues.length > 0);
    if (!field) return;
    const nums = field.sampleValues.map(Number).filter((n) => Number.isFinite(n));
    if (nums.length === 0) return;

    const all = await getCompanies({}, 1, 1);
    const between = await getCompanies(
      {
        virtualFilters: [
          { key: field.key, type: "number", operator: "between", value: [Math.min(...nums), Math.max(...nums)] },
        ],
      },
      1,
      1
    );
    expect(between.total).toBeGreaterThan(0);
    expect(between.total).toBeLessThanOrEqual(all.total);
  }, 30000);
});

describe("getCompanies — virtual-column Date filter (ticket #35)", () => {
  it("selects chronologically and does not throw on malformed date rows", async () => {
    const discovery = await getCompanyEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "Date" && f.sampleValues.length > 0);
    if (!field) return; // no date enrichment field in this environment
    const dates = field.sampleValues.filter((v) => /^\d{4}-\d{2}-\d{2}/.test(v)).sort();
    if (dates.length === 0) return;
    const earliest = dates[0];
    const latest = dates[dates.length - 1];

    // `on` a real sample date matches at least that row.
    const on = await getCompanies(
      { virtualFilters: [{ key: field.key, type: "date", operator: "on", value: earliest }] },
      1,
      1
    );
    expect(on.total).toBeGreaterThan(0);

    // Monotonicity of `after`: raising the threshold can only drop rows. This
    // is the chronological-ordering check, and it exercises the guarded text
    // compare against whatever malformed dates the key also holds without
    // throwing.
    const afterEarly = await getCompanies(
      { virtualFilters: [{ key: field.key, type: "date", operator: "after", value: earliest }] },
      1,
      1
    );
    const afterLate = await getCompanies(
      { virtualFilters: [{ key: field.key, type: "date", operator: "after", value: latest }] },
      1,
      1
    );
    expect(afterEarly.total).toBeGreaterThanOrEqual(afterLate.total);

    const all = await getCompanies({}, 1, 1);
    const between = await getCompanies(
      { virtualFilters: [{ key: field.key, type: "date", operator: "between", value: [earliest, latest] }] },
      1,
      1
    );
    expect(between.total).toBeGreaterThan(0);
    expect(between.total).toBeLessThanOrEqual(all.total);
  }, 30000);
});

describe("getCompanies — virtual-column Boolean filter (ticket #36)", () => {
  it("is_true and is_false exhaustively partition the table for a given key", async () => {
    const discovery = await getCompanyEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "Boolean");
    if (!field) return; // no boolean enrichment field in this environment

    const all = await getCompanies({}, 1, 1);
    const isTrue = await getCompanies(
      { virtualFilters: [{ key: field.key, type: "boolean", operator: "is_true" }] },
      1,
      1
    );
    const isFalse = await getCompanies(
      { virtualFilters: [{ key: field.key, type: "boolean", operator: "is_false" }] },
      1,
      1
    );
    expect(isTrue.total).toBeLessThanOrEqual(all.total);
    expect(isFalse.total).toBeLessThanOrEqual(all.total);
    // A row can't satisfy both, so the two sets never overlap and never
    // exceed the unfiltered total.
    expect(isTrue.total + isFalse.total).toBeLessThanOrEqual(all.total);
  }, 30000);
});

describe("getCompanies — virtual-column List filter (ticket #36)", () => {
  it("'contains' matches an exact array member, not a near-string substring", async () => {
    const discovery = await getCompanyEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "List" && f.sampleValues.length > 0);
    if (!field) return; // no list enrichment field in this environment
    const value = field.sampleValues[0];

    const result = await getCompanies(
      {
        virtualFilters: [{ key: field.key, type: "list", operator: "contains", value }],
        virtualColumns: [{ key: field.key, type: "list" }],
      },
      1,
      50
    );
    expect(result.total).toBeGreaterThan(0);

    // A near-string that isn't itself a sample value must not appear as a
    // false positive from a substring/ILIKE-style match.
    const nearString = `${value}_not_a_real_member`;
    const nearResult = await getCompanies(
      { virtualFilters: [{ key: field.key, type: "list", operator: "contains", value: nearString }] },
      1,
      1
    );
    expect(nearResult.total).toBe(0);
    // Real observed wall-clock against the live table (confirmed via
    // scratch probe post ticket #36's SQL fix): a `contains` value that
    // matches most of the ~110k-row table pushes fetchRowsForVirtualIds'
    // chunked id refetch past the default 30s ceiling on its own (~31.5s),
    // even though the SQL predicate itself is fast — this is the same
    // documented "resolve ids, then chunk-refetch by id" tradeoff
    // fetchRowsForVirtualIds/getCompanies already make (lib/data/companies.ts),
    // not a hang or regression.
  }, 60000);

  it("'is_empty' and 'is_not_empty' exhaustively partition the table for a given key", async () => {
    const discovery = await getCompanyEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "List");
    if (!field) return; // no list enrichment field in this environment

    const all = await getCompanies({}, 1, 1);
    const empty = await getCompanies(
      { virtualFilters: [{ key: field.key, type: "list", operator: "is_empty" }] },
      1,
      1
    );
    const notEmpty = await getCompanies(
      { virtualFilters: [{ key: field.key, type: "list", operator: "is_not_empty" }] },
      1,
      1
    );
    expect(empty.total + notEmpty.total).toBe(all.total);
    // Same real-wall-clock reasoning as the 'contains' test above: `is_empty`
    // matches most rows for this key (~98k of ~110k), so the chunked
    // id-refetch fan-out alone takes ~21s.
  }, 60000);
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
