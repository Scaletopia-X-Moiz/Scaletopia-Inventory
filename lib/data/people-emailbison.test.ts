import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getPeopleForEmailBison } from "@/lib/data/people";
import { includeOnly } from "@/lib/data/include-exclude";

const TEST_PREFIX = "__test-people-emailbison__";

function testLinkedin(slug: string): string {
  return `https://linkedin.com/in/${TEST_PREFIX}${slug}`;
}

/** platform_pushes isn't written by these loaders, but people/companies share
 * the same FK ordering hazard as push-to-ghl.test.ts's cleanupAll when other
 * suites run concurrently against the shared test DB — delete people (the FK
 * child) before companies (the FK parent). */
async function cleanupAll() {
  await supabaseAdmin.from("people").delete().like("linkedin_url", `%${TEST_PREFIX}%`);
  await supabaseAdmin.from("companies").delete().like("domain", `${TEST_PREFIX}%`);
}

beforeAll(cleanupAll);
afterAll(cleanupAll);

let counter = 0;
function unique(label: string): string {
  counter++;
  return `${TEST_PREFIX}${label}-${counter}`;
}

async function insertPerson(overrides: Record<string, unknown>) {
  const { error } = await supabaseAdmin.from("people").insert(overrides);
  if (error) throw error;
}

describe("getPeopleForEmailBison", () => {
  it("returns EmailBisonPushCandidate-shaped rows for the People-table filtered view", async () => {
    const niche = unique("niche");
    await insertPerson({
      linkedin_url: testLinkedin(`solo-${niche}`),
      full_name: "Bison Test Person",
      first_name: "Bison",
      last_name: "Person",
      email: `${TEST_PREFIX}${niche}@example.com`,
      phone: "+15555550100",
      job_title: "VP Sales",
      company_name: "Acme Co",
      domain: "acme.example.com",
      niche_tokens: [niche],
      source: "clay",
      custom_data: { favorite_color: "blue" },
    });

    const candidates = await getPeopleForEmailBison({ niche: includeOnly([niche]) });

    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    expect(candidate.displayName).toBe("Bison Test Person");
    // toMatchObject (not toEqual): createdAt/lastUpdated are DB-generated
    // timestamps (not explicitly set by insertPerson above), so their exact
    // value isn't asserted here — everything else IS checked exactly.
    expect(candidate.record).toMatchObject({
      firstName: "Bison",
      lastName: "Person",
      email: `${TEST_PREFIX}${niche}@example.com`,
      phone: "+15555550100",
      companyName: "Acme Co",
      brandName: null,
      title: "VP Sales",
      website: "acme.example.com",
      // Person's own real columns (only linkedin_url + full_name were set).
      city: null,
      state: null,
      country: null,
      fullName: "Bison Test Person",
      linkedinUrl: testLinkedin(`solo-${niche}`),
      linkedinUsername: null,
      phoneType: null,
      phoneStatus: null,
      emailStatus: null,
      sourceId: null,
      // tags defaults to [] at the DB level (not null) when not set on insert.
      tags: [],
      emailVerifiedAt: null,
      phoneVerifiedAt: null,
      // No company_id on this person, so the company embed is null → all null.
      companyCity: null,
      companyState: null,
      companyCountry: null,
      companyIndustry: null,
      companyEmployeeCount: null,
      companyWebsiteUrl: null,
      companyLinkedinUrl: null,
      companyDomain: null,
      companyPhone: null,
      companyPhoneType: null,
      companyEmail: null,
      companyEmailStatus: null,
      companyNiche: null,
      companyQualityTier: null,
      companyPhoneStatus: null,
      companyClient: null,
      companyCreatedAt: null,
      companyDescription: null,
      companyDomainStatus: null,
      companyEmailVerifiedAt: null,
      companyFoundedYear: null,
      companyKeywords: null,
      companyLastUpdated: null,
      companyMxProvider: null,
      companyPhoneVerifiedAt: null,
      companyRevenue: null,
      companySecurityGateway: null,
      companySource: null,
      companyTags: null,
      companyTechnologies: null,
    });
    expect(candidate.customData).toEqual({ favorite_color: "blue" });
  });
});

// getPeopleForEmailBisonByCompanyFilters (the old resolve-Companies-filters-
// to-linked-People loader) and its coverage here were removed —
// docs/adr/0005-company-native-emailbison-push.md: the Companies-table
// EmailBison push is now company-native (getCompaniesForEmailBison in
// lib/data/companies.ts), not a resolve-to-linked-People loader in this file.
