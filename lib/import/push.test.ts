import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { pushRecords, preflightRecords } from "@/lib/import/push";
import { normalizeSourceTokens } from "@/lib/data/source";

// All test records use this domain prefix so we can clean up safely.
const TEST_PREFIX = "__test-import-push__";

function testDomain(slug: string) {
  return `${TEST_PREFIX}${slug}.example.com`;
}

function testLinkedin(slug: string) {
  return `https://www.linkedin.com/company/${TEST_PREFIX}${slug}/`;
}

function testPersonLinkedin(slug: string) {
  return `https://www.linkedin.com/in/${TEST_PREFIX}${slug}/`;
}

const SOURCE_KEY = `${TEST_PREFIX}source`;
const TAGS: [string, string, string] = ["test-client", "test-niche", "2026-01-01"];

async function cleanupCompanies() {
  await supabaseAdmin
    .from("companies")
    .delete()
    .like("domain", `${TEST_PREFIX}%`);
  // Also catch null-domain records inserted during tests
  await supabaseAdmin
    .from("companies")
    .delete()
    .like("linkedin_url", `%${TEST_PREFIX}%`);
}

async function cleanupPeople() {
  await supabaseAdmin
    .from("people")
    .delete()
    .like("linkedin_url", `%${TEST_PREFIX}%`);
}

async function cleanupHistory() {
  await supabaseAdmin
    .from("import_history")
    .delete()
    .eq("source_key", SOURCE_KEY);
}

beforeAll(async () => {
  await cleanupCompanies();
  await cleanupPeople();
  await cleanupHistory();
});

afterAll(async () => {
  await cleanupCompanies();
  await cleanupPeople();
  await cleanupHistory();
});

// ─── helpers ────────────────────────────────────────────────────────────────

function noopProgress() {}

// ─── preflightRecords ────────────────────────────────────────────────────────

describe("preflightRecords", () => {
  it("identifies existing records by domain", async () => {
    const domain = testDomain("preflight-domain");

    // Use pushRecords to insert the record
    const setup = await pushRecords(
      { records: [{ domain, company_name: "Preflight Domain Co" }], targetTable: "companies", sourceKey: SOURCE_KEY, tags: TAGS },
      noopProgress
    );
    expect(setup.insertedCount + setup.updatedCount).toBe(1);

    const result = await preflightRecords(
      [{ domain }, { domain: testDomain("preflight-new") }],
      "companies"
    );

    expect(result.inputCount).toBe(2);
    expect(result.insertCount).toBe(1);
    expect(result.updateCount).toBe(1);
  });

  it("identifies existing records by linkedin_url when domain is null", async () => {
    const linkedin = testLinkedin("preflight-linkedin");

    await pushRecords(
      { records: [{ linkedin_url: linkedin, company_name: "Preflight LinkedIn Co" }], targetTable: "companies", sourceKey: SOURCE_KEY, tags: TAGS },
      noopProgress
    );

    const result = await preflightRecords(
      [
        { linkedin_url: linkedin, company_name: "Preflight LinkedIn Co" },
        { linkedin_url: testLinkedin("preflight-new-li"), company_name: "New LinkedIn Co" },
      ],
      "companies"
    );

    expect(result.updateCount).toBeGreaterThanOrEqual(1);
    expect(result.insertCount).toBeGreaterThanOrEqual(1);
  });
});

// ─── pushRecords ─────────────────────────────────────────────────────────────

describe("pushRecords — insert", () => {
  it("inserts new records and returns correct count", async () => {
    const records = [
      { domain: testDomain("ins-a"), company_name: "Insert A" },
      { domain: testDomain("ins-b"), company_name: "Insert B" },
      { domain: testDomain("ins-c"), company_name: "Insert C" },
    ];

    const result = await pushRecords(
      { records, targetTable: "companies", sourceKey: SOURCE_KEY, tags: TAGS },
      noopProgress
    );

    expect(result.insertedCount).toBe(3);
    expect(result.updatedCount).toBe(0);
    expect(result.failedCount).toBe(0);
  });

  it("allows null-domain records to insert freely", async () => {
    const records = [
      { linkedin_url: testLinkedin("no-domain-a"), company_name: "No Domain A" },
      { linkedin_url: testLinkedin("no-domain-b"), company_name: "No Domain B" },
    ];

    const result = await pushRecords(
      { records, targetTable: "companies", sourceKey: SOURCE_KEY, tags: TAGS },
      noopProgress
    );

    expect(result.insertedCount).toBe(2);
    expect(result.failedCount).toBe(0);
  });
});

describe("pushRecords — canonical columns", () => {
  // Guard test for docs/adr/0001-dbside-companies-list-via-app-owned-canonical-columns.md:
  // import is the sole writer of country_id/industry_id/source_tokens, so a
  // fresh push must always leave them in sync with the raw columns.
  it("sets country_id/industry_id/source_tokens on insert", async () => {
    const domain = testDomain("canonical-insert");

    await pushRecords(
      {
        records: [
          {
            domain,
            company_name: "Canonical Insert Co",
            country: "united states",
            industry: "Technology; Information and Internet",
          },
        ],
        targetTable: "companies",
        sourceKey: SOURCE_KEY,
        tags: TAGS,
      },
      noopProgress
    );

    const { data } = await supabaseAdmin
      .from("companies")
      .select("country_id,industry_id,source_tokens")
      .eq("domain", domain)
      .single();

    expect(data?.country_id).toBe("US");
    expect(data?.industry_id).toBe("technology, information and internet");
    expect(data?.source_tokens).toEqual(normalizeSourceTokens(SOURCE_KEY));
  });

  it("updates country_id/industry_id/source_tokens on update", async () => {
    const domain = testDomain("canonical-update");

    await pushRecords(
      { records: [{ domain, company_name: "Canonical Update Co", country: "Canada" }], targetTable: "companies", sourceKey: SOURCE_KEY, tags: TAGS },
      noopProgress
    );

    const otherSource = `${SOURCE_KEY}-other`;
    await pushRecords(
      {
        records: [{ domain, company_name: "Canonical Update Co", country: "united kingdom", industry: "SaaS" }],
        targetTable: "companies",
        sourceKey: otherSource,
        tags: TAGS,
      },
      noopProgress
    );

    const { data } = await supabaseAdmin
      .from("companies")
      .select("country_id,industry_id,source_tokens")
      .eq("domain", domain)
      .single();

    expect(data?.country_id).toBe("GB");
    expect(data?.industry_id).toBe("saas");
    // source_tokens is a union across both pushes, not an overwrite.
    expect(data?.source_tokens).toEqual(
      expect.arrayContaining([...normalizeSourceTokens(SOURCE_KEY), ...normalizeSourceTokens(otherSource)])
    );
    expect(data?.source_tokens).toHaveLength(2);
  });

  // Regression test for ticket #83: the Import wizard's Tag Metadata step
  // (client + niche) showed correctly in the pre-push "TAGS TO APPLY"
  // summary but was never written to companies.client/companies.niche on
  // either insert or update — only the `tags` text[] column got them.
  it("sets client/niche on insert", async () => {
    const domain = testDomain("canonical-client-niche-insert");

    await pushRecords(
      {
        records: [{ domain, company_name: "Client Niche Insert Co" }],
        targetTable: "companies",
        sourceKey: SOURCE_KEY,
        tags: TAGS,
      },
      noopProgress
    );

    const { data } = await supabaseAdmin
      .from("companies")
      .select("client,niche")
      .eq("domain", domain)
      .single();

    expect(data?.client).toBe(TAGS[0]);
    expect(data?.niche).toBe(TAGS[1]);
  });

  it("updates client/niche on update", async () => {
    const domain = testDomain("canonical-client-niche-update");
    const oldTags: [string, string, string] = ["old-client", "old-niche", "2020-01-01"];

    await pushRecords(
      { records: [{ domain, company_name: "Client Niche Update Co" }], targetTable: "companies", sourceKey: SOURCE_KEY, tags: oldTags },
      noopProgress
    );

    const newTags: [string, string, string] = ["new-client", "new-niche", "2026-06-01"];
    await pushRecords(
      { records: [{ domain, company_name: "Client Niche Update Co" }], targetTable: "companies", sourceKey: SOURCE_KEY, tags: newTags },
      noopProgress
    );

    const { data } = await supabaseAdmin
      .from("companies")
      .select("client,niche")
      .eq("domain", domain)
      .single();

    expect(data?.client).toBe("new-client");
    expect(data?.niche).toBe("new-niche");
  });
});

describe("pushRecords — people canonical columns", () => {
  // Guard test for ticket "Import: people writes populate the new canonical
  // columns": a fresh people import must always leave country_id/source_tokens/
  // industry_id/employee_count/company_linkedin_url/niche_tokens in sync with
  // the person's own raw data and their linked company's canonical columns.
  it("sets all 6 columns on insert, preferring the linked company's niche", async () => {
    const companyDomain = testDomain("people-canonical-co");
    await pushRecords(
      {
        records: [
          {
            domain: companyDomain,
            company_name: "People Canonical Co",
            industry: "Technology; Information and Internet",
            employee_count: 42,
            linkedin_url: testLinkedin("people-canonical-co"),
          },
        ],
        targetTable: "companies",
        sourceKey: SOURCE_KEY,
        tags: TAGS,
      },
      noopProgress
    );

    // Ticket #83: companies.niche is now always sourced from a push's own
    // tags[1] (canonicalColumnsFor sets it unconditionally, mirroring how
    // company_name/industry/etc. work — there's no such thing as a per-record
    // niche on insert, only a per-push one from the Tag Metadata step). Set
    // it directly here, bypassing the push tags entirely, since this test is
    // specifically about the company's OWN niche column winning over the
    // person-side tag-parsed fallback, not about which tags produced it.
    await supabaseAdmin
      .from("companies")
      .update({ niche: "fintech" })
      .eq("domain", companyDomain);

    const linkedin = testPersonLinkedin("canonical-insert");
    await pushRecords(
      {
        records: [
          {
            linkedin_url: linkedin,
            full_name: "Canonical Insert Person",
            domain: companyDomain,
            country: "united states",
            tags: ["some-other-tag"],
          },
        ],
        targetTable: "people",
        sourceKey: SOURCE_KEY,
        tags: TAGS,
      },
      noopProgress
    );

    const { data } = await supabaseAdmin
      .from("people")
      .select("country_id,source_tokens,industry_id,employee_count,company_linkedin_url,niche_tokens,company_id")
      .eq("linkedin_url", linkedin)
      .single();

    expect(data?.company_id).toBeTruthy();
    expect(data?.country_id).toBe("US");
    expect(data?.source_tokens).toEqual(normalizeSourceTokens(SOURCE_KEY));
    expect(data?.industry_id).toBe("technology, information and internet");
    expect(data?.employee_count).toBe(42);
    expect(data?.company_linkedin_url).toBe(testLinkedin("people-canonical-co"));
    // Company has its own niche set, so it wins over the tag-parsing fallback.
    expect(data?.niche_tokens).toEqual(["fintech"]);
  });

  it("falls back to tag-parsed niche_tokens when the linked company has no niche", async () => {
    const linkedin = testPersonLinkedin("canonical-niche-fallback");
    await pushRecords(
      {
        records: [
          {
            linkedin_url: linkedin,
            full_name: "Niche Fallback Person",
            tags: ["Acme Widgets", "2026-01-01", "campaign:spring", "roofing"],
          },
        ],
        targetTable: "people",
        sourceKey: SOURCE_KEY,
        tags: TAGS,
      },
      noopProgress
    );

    const { data } = await supabaseAdmin
      .from("people")
      .select("niche_tokens,company_id")
      .eq("linkedin_url", linkedin)
      .single();

    expect(data?.company_id).toBeNull();
    expect(data?.niche_tokens).toEqual(["Acme Widgets", "roofing"]);
  });

  it("recomputes source_tokens (union) and company-derived fields on update", async () => {
    const companyDomain = testDomain("people-canonical-update-co");
    await pushRecords(
      {
        records: [
          {
            domain: companyDomain,
            company_name: "People Canonical Update Co",
            employee_count: 7,
            linkedin_url: testLinkedin("people-canonical-update-co"),
          },
        ],
        targetTable: "companies",
        sourceKey: SOURCE_KEY,
        tags: TAGS,
      },
      noopProgress
    );

    const linkedin = testPersonLinkedin("canonical-update");
    await pushRecords(
      { records: [{ linkedin_url: linkedin, full_name: "Canonical Update Person" }], targetTable: "people", sourceKey: SOURCE_KEY, tags: TAGS },
      noopProgress
    );

    const otherSource = `${SOURCE_KEY}-other`;
    await pushRecords(
      {
        records: [{ linkedin_url: linkedin, full_name: "Canonical Update Person", domain: companyDomain }],
        targetTable: "people",
        sourceKey: otherSource,
        tags: TAGS,
      },
      noopProgress
    );

    const { data } = await supabaseAdmin
      .from("people")
      .select("source_tokens,employee_count,company_linkedin_url")
      .eq("linkedin_url", linkedin)
      .single();

    // source_tokens is a union across both pushes, not an overwrite.
    expect(data?.source_tokens).toEqual(
      expect.arrayContaining([...normalizeSourceTokens(SOURCE_KEY), ...normalizeSourceTokens(otherSource)])
    );
    expect(data?.employee_count).toBe(7);
    expect(data?.company_linkedin_url).toBe(testLinkedin("people-canonical-update-co"));
  });
});

describe("import_bulk_update_companies — propagates canonical fields to linked people", () => {
  // Guard test for ticket "Company updates propagate canonical fields to
  // linked people": a company enrichment (industry/employee_count/linkedin_url/
  // niche) must push through to every person already linked via
  // people.company_id, without those people being re-imported themselves —
  // and must NOT touch a person linked to a different company.
  it("updates linked people's columns and leaves an unrelated person untouched", async () => {
    const domain = testDomain("propagation-co");
    const otherDomain = testDomain("propagation-other-co");

    await pushRecords(
      {
        records: [
          { domain, company_name: "Propagation Co", employee_count: 5 },
          { domain: otherDomain, company_name: "Propagation Other Co", employee_count: 5 },
        ],
        targetTable: "companies",
        sourceKey: SOURCE_KEY,
        tags: TAGS,
      },
      noopProgress
    );

    // Ticket #83: companies.niche is now sourced from this whole push's
    // TAGS[1] ("test-niche") on insert, same as every other record above —
    // so a raw per-record `niche` field would just get overwritten by that,
    // like company_name etc. Set otherDomain's niche directly instead,
    // mirroring the "enriched-niche" direct write further down, to simulate
    // however else a company's niche can differ from a given push's tags.
    await supabaseAdmin
      .from("companies")
      .update({ niche: "unrelated-niche" })
      .eq("domain", otherDomain);

    const linkedin = testPersonLinkedin("propagation-linked");
    const otherLinkedin = testPersonLinkedin("propagation-unrelated");
    await pushRecords(
      {
        records: [
          { linkedin_url: linkedin, full_name: "Propagation Linked Person", domain },
          { linkedin_url: otherLinkedin, full_name: "Propagation Unrelated Person", domain: otherDomain },
        ],
        targetTable: "people",
        sourceKey: SOURCE_KEY,
        tags: TAGS,
      },
      noopProgress
    );

    const { data: beforeOther } = await supabaseAdmin
      .from("people")
      .select("niche_tokens")
      .eq("linkedin_url", otherLinkedin)
      .single();
    expect(beforeOther?.niche_tokens).toEqual(["unrelated-niche"]);

    // Set it directly here to simulate however else a company's niche gets
    // edited post-import (e.g. a manual edit, or a different push whose tags
    // carry no niche — see NO_NICHE_TAGS below), so the propagation step
    // below is exercised against a real empty-to-set niche transition.
    await supabaseAdmin.from("companies").update({ niche: "enriched-niche" }).eq("domain", domain);

    // Enrich the company WITHOUT re-importing the linked person. Uses tags
    // with an empty niche/client so this push's own COALESCE-based write
    // (ticket #83) doesn't clobber the "enriched-niche" set directly above —
    // mirrors a real push whose Tag Metadata step was left blank.
    const NO_NICHE_TAGS: [string, string, string] = ["", "", "2026-01-01"];
    await pushRecords(
      {
        records: [
          {
            domain,
            company_name: "Propagation Co",
            employee_count: 250,
            industry: "SaaS",
            linkedin_url: testLinkedin("propagation-co-enriched"),
          },
        ],
        targetTable: "companies",
        sourceKey: SOURCE_KEY,
        tags: NO_NICHE_TAGS,
      },
      noopProgress
    );

    const { data: linked } = await supabaseAdmin
      .from("people")
      .select("industry_id,employee_count,company_linkedin_url,niche_tokens")
      .eq("linkedin_url", linkedin)
      .single();

    expect(linked?.industry_id).toBe("saas");
    expect(linked?.employee_count).toBe(250);
    expect(linked?.company_linkedin_url).toBe(testLinkedin("propagation-co-enriched"));
    expect(linked?.niche_tokens).toEqual(["enriched-niche"]);

    // Unrelated person (different company) must be untouched.
    const { data: afterOther } = await supabaseAdmin
      .from("people")
      .select("employee_count,niche_tokens")
      .eq("linkedin_url", otherLinkedin)
      .single();
    expect(afterOther?.employee_count).toBe(5);
    expect(afterOther?.niche_tokens).toEqual(["unrelated-niche"]);
  });
});

describe("pushRecords — idempotency", () => {
  it("second push of same records produces 0 inserts and N updates", async () => {
    const records = [
      { domain: testDomain("idem-a"), company_name: "Idempotent A" },
      { domain: testDomain("idem-b"), company_name: "Idempotent B" },
    ];

    const opts = {
      records,
      targetTable: "companies" as const,
      sourceKey: SOURCE_KEY,
      tags: TAGS,
    };

    const first = await pushRecords(opts, noopProgress);
    expect(first.insertedCount).toBe(2);

    const second = await pushRecords(opts, noopProgress);
    expect(second.insertedCount).toBe(0);
    expect(second.updatedCount).toBe(2);
    expect(second.failedCount).toBe(0);
  });
});

describe("pushRecords — update behaviour", () => {
  it("overwrites tags on update", async () => {
    const domain = testDomain("update-tags");

    // First push to insert the record
    const oldTags: [string, string, string] = ["old-client", "old-niche", "2020-01-01"];
    await pushRecords(
      { records: [{ domain, company_name: "Update Tags Co" }], targetTable: "companies", sourceKey: SOURCE_KEY, tags: oldTags },
      noopProgress
    );

    // Second push with new tags — should update
    const newTags: [string, string, string] = ["new-client", "new-niche", "2026-06-01"];
    const updateResult = await pushRecords(
      { records: [{ domain, company_name: "Update Tags Co" }], targetTable: "companies", sourceKey: SOURCE_KEY, tags: newTags },
      noopProgress
    );

    expect(updateResult.updatedCount).toBe(1);
    expect(updateResult.insertedCount).toBe(0);

    const { data } = await supabaseAdmin
      .from("companies")
      .select("tags")
      .eq("domain", domain)
      .single();

    expect(data?.tags).toEqual(newTags);
  });
});

describe("pushRecords — progress events", () => {
  it("emits inserting and updating phase events", async () => {
    const domain = testDomain("progress-existing");

    await pushRecords(
      { records: [{ domain, company_name: "Progress Existing Co" }], targetTable: "companies", sourceKey: SOURCE_KEY, tags: TAGS },
      noopProgress
    );

    const phases: string[] = [];

    await pushRecords(
      {
        records: [
          { domain: testDomain("progress-new"), company_name: "Progress New Co" },
          { domain, company_name: "Progress Existing Co" },
        ],
        targetTable: "companies",
        sourceKey: SOURCE_KEY,
        tags: TAGS,
      },
      (p) => phases.push(p.phase)
    );

    expect(phases).toContain("inserting");
    expect(phases).toContain("updating");
    expect(phases[phases.length - 1]).toBe("done");
  });
});

describe("pushRecords — import_history", () => {
  it("writes a history row with correct counts", async () => {
    const historySource = `${SOURCE_KEY}-history`;
    const historyTags: [string, string, string] = ["hist-client", "hist-niche", "2026-06-29"];

    const records = [
      { domain: testDomain("hist-a"), company_name: "History A Co" },
      { domain: testDomain("hist-b"), company_name: "History B Co" },
    ];

    const result = await pushRecords(
      {
        records,
        targetTable: "companies",
        sourceKey: historySource,
        tags: historyTags,
      },
      noopProgress
    );

    expect(result.historyId).toBeTruthy();
    expect(result.insertedCount).toBe(2);

    const { data: row } = await supabaseAdmin
      .from("import_history")
      .select("*")
      .eq("id", result.historyId!)
      .single();

    expect(row).toBeTruthy();
    expect(row!.inserted_count).toBe(result.insertedCount);
    expect(row!.updated_count).toBe(result.updatedCount);
    expect(row!.failed_count).toBe(result.failedCount);
    expect(row!.source_key).toBe(historySource);
    expect(row!.target_table).toBe("companies");

    // Cleanup extra history row and records
    await supabaseAdmin.from("import_history").delete().eq("source_key", historySource);
    await supabaseAdmin.from("companies").delete().like("domain", `${TEST_PREFIX}hist-%`);
  });
});
