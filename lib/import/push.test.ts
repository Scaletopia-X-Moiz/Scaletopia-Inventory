import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { pushRecords, preflightRecords } from "@/lib/import/push";

// All test records use this domain prefix so we can clean up safely.
const TEST_PREFIX = "__test-import-push__";

function testDomain(slug: string) {
  return `${TEST_PREFIX}${slug}.example.com`;
}

function testLinkedin(slug: string) {
  return `https://www.linkedin.com/company/${TEST_PREFIX}${slug}/`;
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

async function cleanupHistory() {
  await supabaseAdmin
    .from("import_history")
    .delete()
    .eq("source_key", SOURCE_KEY);
}

beforeAll(async () => {
  await cleanupCompanies();
  await cleanupHistory();
});

afterAll(async () => {
  await cleanupCompanies();
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
