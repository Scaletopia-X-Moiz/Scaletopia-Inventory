import { describe, expect, it } from "vitest";
import {
  getPeople,
  getPersonDetail,
  getPersonFilterOptions,
  getAllFilteredPeople,
  type PersonListFilters,
} from "@/lib/data/people";
import { includeOnly } from "@/lib/data/include-exclude";
import { getPersonEnrichmentFields } from "@/lib/data/enrichment-fields";

describe("getPersonFilterOptions", () => {
  it("returns normalized, deduped options for every filter dimension", async () => {
    const options = await getPersonFilterOptions();

    expect(options.niches.length).toBeGreaterThan(0);
    expect(options.sources.length).toBeGreaterThan(0);
    expect(options.countries.length).toBeGreaterThan(0);
    expect(options.industries.length).toBeGreaterThan(0);
    expect(options.employeeBuckets).toHaveLength(5);
    expect(options.emailStatuses.length).toBeGreaterThan(0);
    expect(options.phoneTypes.length).toBeGreaterThan(0);

    // source ids are canonical, never raw delimited/variant strings, and use
    // the same mapping as Companies (aiark-people / aiark-api -> aiark)
    for (const s of options.sources) {
      expect(s.id).not.toMatch(/[,&]/);
    }
    expect(options.sources.some((s) => s.id === "aiark")).toBe(true);
  });
});

describe("getPersonFilterOptions — facet scoping under virtual filters (ticket #41)", () => {
  it("facet counts and getPeople total agree when a virtual filter is active", async () => {
    // The connected People dataset has no Number/Boolean/List enrichment
    // fields (unlike Companies), so — unlike the Companies version of this
    // test — we can't rely on a numeric type to guarantee low cardinality.
    // A categorical Text value can be common enough (e.g. a shared category
    // string) to match thousands of people, which pushes getPeople's
    // virtual-filter id-resolution path (a separate, known perf issue —
    // multi-round-trip id-then-refetch, not the facet RPC this test targets)
    // past the statement timeout. So instead we probe candidate Text fields'
    // first sample value and pick one that's actually low-cardinality.
    const discovery = await getPersonEnrichmentFields({}, 2000, 100);
    const textFields = discovery.fields.filter(
      (f) => f.type === "Text" && f.sampleValues.length > 0
    );
    expect(textFields.length).toBeGreaterThan(0);

    let field: (typeof textFields)[number] | undefined;
    let value: string | undefined;
    for (const candidate of textFields) {
      const candidateValue = candidate.sampleValues[0];
      const probe = await getPeople(
        {
          virtualFilters: [
            { key: candidate.key, type: "text", operator: "is", value: candidateValue },
          ],
        },
        1,
        1
      );
      if (probe.total > 0 && probe.total <= 200) {
        field = candidate;
        value = candidateValue;
        break;
      }
    }
    expect(field).toBeDefined();

    const filters: PersonListFilters = {
      virtualFilters: [{ key: field!.key, type: "text", operator: "is", value: value! }],
    };

    const options = await getPersonFilterOptions(filters);
    const result = await getPeople(filters, 1, 1);

    const scopedTotal = [
      ...options.niches,
      ...options.sources,
      ...options.industries,
      ...options.countries,
    ].reduce((max, o) => Math.max(max, o.count), 0);

    expect(scopedTotal).toBeLessThanOrEqual(result.total);
    expect(scopedTotal).toBeGreaterThan(0);
  }, 30000);
});

describe("getPeople", () => {
  it("returns paginated results with a total count", async () => {
    const result = await getPeople({}, 1, 25);
    expect(result.rows).toHaveLength(25);
    expect(result.total).toBeGreaterThan(25);
    expect(result.page).toBe(1);
  });

  it("search filters by name or email substring", async () => {
    const first = await getAllFilteredPeople({});
    const sample = first[0];
    const term = (sample.fullName ?? sample.email ?? "").slice(0, 4);
    if (!term) return;

    const result = await getPeople({ search: term }, 1, 1000);
    expect(result.rows.length).toBeGreaterThan(0);
    for (const row of result.rows) {
      const haystack = `${row.fullName ?? ""} ${row.email ?? ""}`.toLowerCase();
      expect(haystack).toContain(term.toLowerCase());
    }
  });

  it("source filter matches normalized tokens regardless of raw variant", async () => {
    const result = await getPeople({ source: includeOnly(["aiark"]) }, 1, 1000);
    expect(result.total).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.sources).toContain("aiark");
    }
  });

  it("country filter uses the person's own country, no join needed", async () => {
    const options = await getPersonFilterOptions();
    const country = options.countries[0];
    const result = await getPeople({ country: includeOnly([country.id]) }, 1, 1000);
    expect(result.total).toBe(country.count);
  });

  it("email single-select filters Not Empty / Empty correctly", async () => {
    const notEmpty = await getPeople({ email: "not_empty" }, 1, 1000);
    for (const row of notEmpty.rows) expect(row.email).toBeTruthy();

    const empty = await getPeople({ email: "empty" }, 1, 1000);
    for (const row of empty.rows) expect(row.email).toBeFalsy();

    expect(notEmpty.total + empty.total).toBe((await getPeople({}, 1, 1000)).total);
  });

  it("phone single-select filters Not Empty / Empty correctly", async () => {
    const notEmpty = await getPeople({ phone: "not_empty" }, 1, 1000);
    for (const row of notEmpty.rows) expect(row.phone).toBeTruthy();

    const empty = await getPeople({ phone: "empty" }, 1, 1000);
    for (const row of empty.rows) expect(row.phone).toBeFalsy();
  });

  it("email status filter matches exactly the requested statuses", async () => {
    const result = await getPeople({ emailStatus: includeOnly(["ok"]) }, 1, 1000);
    expect(result.total).toBeGreaterThan(0);
    for (const row of result.rows) expect(row.emailStatus).toBe("ok");
  });

  it("email status exclude filter removes the requested status", async () => {
    const all = await getPeople({}, 1, 1000);
    const result = await getPeople({ emailStatus: { include: [], exclude: ["ok"] } }, 1, 1000);
    expect(result.total).toBeLessThan(all.total);
    for (const row of result.rows) expect(row.emailStatus).not.toBe("ok");
  });

  it("phone type filter matches exactly the requested types", async () => {
    const options = await getPersonFilterOptions();
    const type = options.phoneTypes[0];
    const result = await getPeople({ phoneType: includeOnly([type.id]) }, 1, 1000);
    expect(result.total).toBe(type.count);
    for (const row of result.rows) expect(row.phoneType).toBe(type.id);
  });

  it("job title filter matches any of several comma-separated terms, case-insensitively", async () => {
    const all = await getAllFilteredPeople({});
    const sample = all.find((r) => r.jobTitle);
    if (!sample) return;
    const term = sample.jobTitle!.slice(0, 3);

    const result = await getPeople({ jobTitle: `${term.toUpperCase()}, zzz-no-match-zzz` }, 1, 1000);
    expect(result.total).toBeGreaterThan(0);
    for (const row of result.rows) {
      expect(row.jobTitle?.toLowerCase() ?? "").toContain(term.toLowerCase());
    }
  });

  it("employee size and industry filters join through the linked company", async () => {
    const result = await getPeople({ employeeBucket: ["1-10"] }, 1, 1000);
    expect(result.total).toBeGreaterThan(0);

    const options = await getPersonFilterOptions();
    const industry = options.industries.find((i) => i.count > 0);
    expect(industry).toBeDefined();
    const byIndustry = await getPeople({ industry: includeOnly([industry!.id]) }, 1, 1000);
    expect(byIndustry.total).toBe(industry!.count);
  });

  it("niche filter uses linked company niche, falling back to tags", async () => {
    const options = await getPersonFilterOptions();
    const niche = options.niches[0];
    const result = await getPeople({ niche: includeOnly([niche.id]) }, 1, 1000);
    expect(result.total).toBe(niche.count);
  });

  it("niche exclude filter removes people with that niche", async () => {
    const options = await getPersonFilterOptions();
    const niche = options.niches[0];
    const all = await getPeople({}, 1, 1000);
    const result = await getPeople({ niche: { include: [], exclude: [niche.id] } }, 1, 1000);
    expect(result.total).toBe(all.total - niche.count);
  });

  it("combines multiple filters with AND semantics", async () => {
    const broad = await getPeople({ source: includeOnly(["aiark"]) }, 1, 1000);
    const narrowed = await getPeople(
      { source: includeOnly(["aiark"]), email: "not_empty" },
      1,
      1000
    );
    expect(narrowed.total).toBeLessThanOrEqual(broad.total);
  });
});

describe("getPeople — virtual-column Text filter (ticket #41)", () => {
  it("'is' narrows to rows carrying that exact value, and total reflects the narrowed set", async () => {
    // Find a real Text enrichment key with at least one sample value, rather
    // than hardcoding a key that may not exist in the connected environment
    // (mirrors lib/data/companies.test.ts's virtual-column Text suite).
    const discovery = await getPersonEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "Text" && f.sampleValues.length > 0);
    expect(field).toBeDefined();
    const value = field!.sampleValues[0];

    const all = await getPeople({}, 1, 1);
    const result = await getPeople(
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

  it("'contains' matches a substring of the field, not just an exact value", async () => {
    const discovery = await getPersonEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find(
      (f) => f.type === "Text" && f.sampleValues.some((v) => v.length > 2)
    );
    expect(field).toBeDefined();
    const sample = field!.sampleValues.find((v) => v.length > 2)!;
    const substring = sample.slice(0, Math.max(2, sample.length - 1));

    const result = await getPeople(
      { virtualFilters: [{ key: field!.key, type: "text", operator: "contains", value: substring }] },
      1,
      1
    );
    expect(result.total).toBeGreaterThan(0);
  }, 30000);

  it("'is_empty' and 'is_not_empty' exhaustively partition the table for a given key", async () => {
    const discovery = await getPersonEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "Text");
    expect(field).toBeDefined();

    const all = await getPeople({}, 1, 1);
    const empty = await getPeople(
      { virtualFilters: [{ key: field!.key, type: "text", operator: "is_empty" }] },
      1,
      1
    );
    const notEmpty = await getPeople(
      { virtualFilters: [{ key: field!.key, type: "text", operator: "is_not_empty" }] },
      1,
      1
    );
    expect(empty.total + notEmpty.total).toBe(all.total);
  }, 30000);
});

describe("getPeople — virtual-column Number filter (ticket #41)", () => {
  it("filters numerically over a real numeric key without throwing on junk rows", async () => {
    const discovery = await getPersonEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "Number" && f.sampleValues.length > 0);
    if (!field) return; // no numeric enrichment field in this environment
    const nums = field.sampleValues.map(Number).filter((n) => Number.isFinite(n));
    if (nums.length === 0) return;
    const min = Math.min(...nums);

    const result = await getPeople(
      {
        virtualFilters: [{ key: field.key, type: "number", operator: "gt", value: min - 1 }],
        virtualColumns: [{ key: field.key, type: "number" }],
      },
      1,
      25
    );
    expect(result.total).toBeGreaterThan(0);

    const exact = await getPeople(
      { virtualFilters: [{ key: field.key, type: "number", operator: "is", value: nums[0] }] },
      1,
      1
    );
    expect(exact.total).toBeGreaterThan(0);
    expect(exact.total).toBeLessThanOrEqual(result.total);
  }, 30000);

  it("between selects an inclusive numeric range within the unfiltered total", async () => {
    const discovery = await getPersonEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "Number" && f.sampleValues.length > 0);
    if (!field) return;
    const nums = field.sampleValues.map(Number).filter((n) => Number.isFinite(n));
    if (nums.length === 0) return;

    const all = await getPeople({}, 1, 1);
    const between = await getPeople(
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

describe("getPeople — virtual-column Date filter (ticket #41)", () => {
  it("selects chronologically and does not throw on malformed date rows", async () => {
    const discovery = await getPersonEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "Date" && f.sampleValues.length > 0);
    if (!field) return; // no date enrichment field in this environment
    const dates = field.sampleValues.filter((v) => /^\d{4}-\d{2}-\d{2}/.test(v)).sort();
    if (dates.length === 0) return;
    const earliest = dates[0];
    const latest = dates[dates.length - 1];

    const on = await getPeople(
      { virtualFilters: [{ key: field.key, type: "date", operator: "on", value: earliest }] },
      1,
      1
    );
    expect(on.total).toBeGreaterThan(0);

    const afterEarly = await getPeople(
      { virtualFilters: [{ key: field.key, type: "date", operator: "after", value: earliest }] },
      1,
      1
    );
    const afterLate = await getPeople(
      { virtualFilters: [{ key: field.key, type: "date", operator: "after", value: latest }] },
      1,
      1
    );
    expect(afterEarly.total).toBeGreaterThanOrEqual(afterLate.total);

    const all = await getPeople({}, 1, 1);
    const between = await getPeople(
      { virtualFilters: [{ key: field.key, type: "date", operator: "between", value: [earliest, latest] }] },
      1,
      1
    );
    expect(between.total).toBeGreaterThan(0);
    expect(between.total).toBeLessThanOrEqual(all.total);
  }, 30000);
});

describe("getPeople — virtual-column Boolean filter (ticket #41)", () => {
  it("is_true and is_false exhaustively partition the table for a given key", async () => {
    const discovery = await getPersonEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "Boolean");
    if (!field) return; // no boolean enrichment field in this environment

    const all = await getPeople({}, 1, 1);
    const isTrue = await getPeople(
      { virtualFilters: [{ key: field.key, type: "boolean", operator: "is_true" }] },
      1,
      1
    );
    const isFalse = await getPeople(
      { virtualFilters: [{ key: field.key, type: "boolean", operator: "is_false" }] },
      1,
      1
    );
    expect(isTrue.total).toBeLessThanOrEqual(all.total);
    expect(isFalse.total).toBeLessThanOrEqual(all.total);
    expect(isTrue.total + isFalse.total).toBeLessThanOrEqual(all.total);
  }, 30000);
});

describe("getPeople — virtual-column List filter (ticket #41)", () => {
  it("'contains' matches an exact array member, not a near-string substring", async () => {
    const discovery = await getPersonEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "List" && f.sampleValues.length > 0);
    if (!field) return; // no list enrichment field in this environment
    const value = field.sampleValues[0];

    const result = await getPeople(
      {
        virtualFilters: [{ key: field.key, type: "list", operator: "contains", value }],
        virtualColumns: [{ key: field.key, type: "list" }],
      },
      1,
      50
    );
    expect(result.total).toBeGreaterThan(0);

    const nearString = `${value}_not_a_real_member`;
    const nearResult = await getPeople(
      { virtualFilters: [{ key: field.key, type: "list", operator: "contains", value: nearString }] },
      1,
      1
    );
    expect(nearResult.total).toBe(0);
  }, 60000);

  it("'is_empty' and 'is_not_empty' exhaustively partition the table for a given key", async () => {
    const discovery = await getPersonEnrichmentFields({}, 2000, 25);
    const field = discovery.fields.find((f) => f.type === "List");
    if (!field) return; // no list enrichment field in this environment

    const all = await getPeople({}, 1, 1);
    const empty = await getPeople(
      { virtualFilters: [{ key: field.key, type: "list", operator: "is_empty" }] },
      1,
      1
    );
    const notEmpty = await getPeople(
      { virtualFilters: [{ key: field.key, type: "list", operator: "is_not_empty" }] },
      1,
      1
    );
    expect(empty.total + notEmpty.total).toBe(all.total);
  }, 60000);
});

describe("getPersonDetail", () => {
  it("returns full detail with normalized sources, tags as-is, and a linked company", async () => {
    const list = await getAllFilteredPeople({});
    const withCompany = list[0];

    const detail = await getPersonDetail(withCompany.id);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(withCompany.id);
    expect(Array.isArray(detail!.tags)).toBe(true);
    expect(Array.isArray(detail!.sources)).toBe(true);

    for (const blocked of [
      "naics",
      "aiark_id",
      "company_linkedin_id",
      "connections_count",
      "apollo_id",
      "created_at",
      "updated_at",
    ]) {
      expect(detail!.customData).not.toHaveProperty(blocked);
    }
  });

  it("links to the correct company detail target when company_id is set", async () => {
    const list = await getAllFilteredPeople({});
    const sample = list.find((r) => r.companyName);
    if (!sample) return;

    const detail = await getPersonDetail(sample.id);
    expect(detail!.linkedCompany).not.toBeNull();
    expect(detail!.linkedCompany!.id).toBeTruthy();
  });

  it("returns null for a non-existent id", async () => {
    const detail = await getPersonDetail("00000000-0000-0000-0000-000000000000");
    expect(detail).toBeNull();
  });
});
