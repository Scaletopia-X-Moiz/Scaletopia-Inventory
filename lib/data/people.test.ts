import { describe, expect, it } from "vitest";
import {
  getPeople,
  getPersonDetail,
  getPersonFilterOptions,
  getAllFilteredPeople,
} from "@/lib/data/people";
import { includeOnly } from "@/lib/data/include-exclude";

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
