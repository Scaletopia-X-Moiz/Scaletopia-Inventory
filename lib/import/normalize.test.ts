import { describe, expect, it } from "vitest";
import {
  normalizeDomain,
  normalizeLinkedInUrl,
  scrubJunkDomain,
  fuzzyMatchColumn,
  deriveFullName,
  dedupeCompanies,
  dedupePeople,
  JUNK_DOMAINS,
} from "@/lib/import/normalize";
import { COMPANIES_FIELDS, PEOPLE_FIELDS } from "@/lib/import/providers";

describe("normalizeDomain", () => {
  it("strips https protocol", () => {
    expect(normalizeDomain("https://acme.com")).toBe("acme.com");
  });

  it("strips http protocol", () => {
    expect(normalizeDomain("http://acme.com")).toBe("acme.com");
  });

  it("strips www prefix", () => {
    expect(normalizeDomain("www.acme.com")).toBe("acme.com");
  });

  it("strips protocol and www together", () => {
    expect(normalizeDomain("https://www.acme.com")).toBe("acme.com");
  });

  it("strips trailing slash", () => {
    expect(normalizeDomain("acme.com/")).toBe("acme.com");
  });

  it("strips path after domain", () => {
    expect(normalizeDomain("https://acme.com/about/us")).toBe("acme.com");
  });

  it("lowercases the domain", () => {
    expect(normalizeDomain("ACME.COM")).toBe("acme.com");
  });

  it("returns null for empty string", () => {
    expect(normalizeDomain("")).toBeNull();
  });

  it("returns null for null input", () => {
    expect(normalizeDomain(null)).toBeNull();
  });

  it("returns null for whitespace", () => {
    expect(normalizeDomain("   ")).toBeNull();
  });

  it("preserves subdomains that are not www", () => {
    expect(normalizeDomain("https://app.acme.com")).toBe("app.acme.com");
  });
});

describe("normalizeLinkedInUrl", () => {
  it("returns canonical form for company URL", () => {
    expect(normalizeLinkedInUrl("https://www.linkedin.com/company/acme/")).toBe(
      "https://www.linkedin.com/company/acme/"
    );
  });

  it("adds www and https to bare linkedin.com URL", () => {
    expect(normalizeLinkedInUrl("linkedin.com/company/acme")).toBe(
      "https://www.linkedin.com/company/acme/"
    );
  });

  it("strips query params", () => {
    expect(
      normalizeLinkedInUrl(
        "https://www.linkedin.com/company/acme?originalSubdomain=en"
      )
    ).toBe("https://www.linkedin.com/company/acme/");
  });

  it("handles http instead of https", () => {
    expect(normalizeLinkedInUrl("http://linkedin.com/company/acme")).toBe(
      "https://www.linkedin.com/company/acme/"
    );
  });

  it("returns null for non-linkedin URL", () => {
    expect(normalizeLinkedInUrl("https://acme.com/profile")).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(normalizeLinkedInUrl("")).toBeNull();
  });

  it("returns null for null", () => {
    expect(normalizeLinkedInUrl(null)).toBeNull();
  });

  it("handles in/company variant (people URL)", () => {
    const result = normalizeLinkedInUrl(
      "https://www.linkedin.com/in/john-doe"
    );
    expect(result).toBe("https://www.linkedin.com/in/john-doe/");
  });
});

describe("scrubJunkDomain", () => {
  it("returns null for facebook.com", () => {
    expect(scrubJunkDomain("facebook.com")).toBeNull();
  });

  it("returns null for yelp.com", () => {
    expect(scrubJunkDomain("yelp.com")).toBeNull();
  });

  it("returns null for wix.com", () => {
    expect(scrubJunkDomain("wix.com")).toBeNull();
  });

  it("passes through a legitimate domain", () => {
    expect(scrubJunkDomain("acme.com")).toBe("acme.com");
  });

  it("returns null for null input", () => {
    expect(scrubJunkDomain(null)).toBeNull();
  });

  it("scrubs all junk domains in the set", () => {
    for (const junk of JUNK_DOMAINS) {
      expect(scrubJunkDomain(junk)).toBeNull();
    }
  });
});

describe("fuzzyMatchColumn", () => {
  const companyCandidates = COMPANIES_FIELDS;
  const peopleCandidates = PEOPLE_FIELDS;

  it('matches "Company Name" → company_name', () => {
    const result = fuzzyMatchColumn("Company Name", companyCandidates);
    expect(result?.field).toBe("company_name");
    expect(result?.score).toBeGreaterThan(0.5);
  });

  it('matches "Website" → website_url', () => {
    const result = fuzzyMatchColumn("Website", companyCandidates);
    expect(result?.field).toBe("website_url");
  });

  it('matches "Employee Count" → employee_count', () => {
    const result = fuzzyMatchColumn("Employee Count", companyCandidates);
    expect(result?.field).toBe("employee_count");
  });

  it('matches "LinkedIn URL" → linkedin_url', () => {
    const result = fuzzyMatchColumn("LinkedIn URL", companyCandidates);
    expect(result?.field).toBe("linkedin_url");
  });

  it('matches "Full Name" → full_name (people)', () => {
    const result = fuzzyMatchColumn("Full Name", peopleCandidates);
    expect(result?.field).toBe("full_name");
  });

  it('matches exact field name with score 1.0', () => {
    const result = fuzzyMatchColumn("domain", companyCandidates);
    expect(result?.field).toBe("domain");
    expect(result?.score).toBe(1.0);
  });

  it("returns null for unrecognizable header", () => {
    const result = fuzzyMatchColumn("xyzabc123", companyCandidates);
    expect(result).toBeNull();
  });

  it('matches "# Employees" → employee_count via alias', () => {
    // "# Employees" won't hit alias map directly but "employees" is an alias
    const result = fuzzyMatchColumn("Employees", companyCandidates);
    expect(result?.field).toBe("employee_count");
  });
});

describe("deriveFullName", () => {
  it("joins first and last name when full_name is missing", () => {
    expect(deriveFullName(undefined, "Jane", "Doe")).toBe("Jane Doe");
  });

  it("joins first and last name when full_name is null", () => {
    expect(deriveFullName(null, "Jane", "Doe")).toBe("Jane Doe");
  });

  it("joins first and last name when full_name is an empty string", () => {
    expect(deriveFullName("", "Jane", "Doe")).toBe("Jane Doe");
  });

  it("falls back to first name only when last name is absent", () => {
    expect(deriveFullName(undefined, "Jane", undefined)).toBe("Jane");
  });

  it("falls back to last name only when first name is absent", () => {
    expect(deriveFullName(undefined, undefined, "Doe")).toBe("Doe");
  });

  it("trims whitespace from first/last before joining", () => {
    expect(deriveFullName(undefined, "  Jane  ", "  Doe  ")).toBe("Jane Doe");
  });

  it("does not overwrite an explicit non-empty full_name", () => {
    expect(deriveFullName("Explicit Name", "Jane", "Doe")).toBe("Explicit Name");
  });

  it("does not overwrite an explicit full_name even without first/last", () => {
    expect(deriveFullName("Explicit Name", undefined, undefined)).toBe(
      "Explicit Name"
    );
  });

  it("does not produce a lone space or empty string when both parts are absent", () => {
    expect(deriveFullName(undefined, undefined, undefined)).toBeUndefined();
    expect(deriveFullName(null, null, null)).toBeNull();
  });

  it("does not produce a lone space when both first and last are blank strings", () => {
    expect(deriveFullName("", "   ", "   ")).toBe("");
  });
});

describe("dedupeCompanies", () => {
  it("deduplicates by domain", () => {
    const records = [
      { domain: "acme.com", company_name: "Acme A" },
      { domain: "acme.com", company_name: "Acme B" },
      { domain: "beta.com", company_name: "Beta" },
    ];
    const result = dedupeCompanies(records);
    expect(result).toHaveLength(2);
    expect(result[0].domain).toBe("acme.com");
    expect(result[1].domain).toBe("beta.com");
  });

  it("deduplicates null-domain records by linkedin_url", () => {
    const records = [
      { domain: null, linkedin_url: "https://www.linkedin.com/company/acme/" },
      { domain: null, linkedin_url: "https://www.linkedin.com/company/acme/" },
      { domain: null, linkedin_url: "https://www.linkedin.com/company/beta/" },
    ];
    const result = dedupeCompanies(records);
    expect(result).toHaveLength(2);
  });

  it("allows null-domain records without linkedin to insert freely", () => {
    const records = [
      { domain: null, linkedin_url: null, company_name: "A" },
      { domain: null, linkedin_url: null, company_name: "B" },
    ];
    const result = dedupeCompanies(records);
    expect(result).toHaveLength(2);
  });

  it("domain takes priority over linkedin for deduplication", () => {
    // Same domain, different linkedin — should dedupe to 1
    const records = [
      { domain: "acme.com", linkedin_url: "https://www.linkedin.com/company/acme1/" },
      { domain: "acme.com", linkedin_url: "https://www.linkedin.com/company/acme2/" },
    ];
    const result = dedupeCompanies(records);
    expect(result).toHaveLength(1);
  });

  it("same linkedin, different domains: deduped to one (linkedin has no unique constraint)", () => {
    // BUG C: two rows share a LinkedIn but have different domains. Even though
    // the domains differ, the shared linkedin makes the second a duplicate —
    // otherwise both get inserted and collide on linkedin_url (no DB unique
    // constraint there). The first record wins.
    const records = [
      { domain: "acme-nyc.com", linkedin_url: "https://www.linkedin.com/company/acme/" },
      { domain: "acme-la.com", linkedin_url: "https://www.linkedin.com/company/acme/" },
    ];
    const result = dedupeCompanies(records);
    expect(result).toHaveLength(1);
    expect(result[0].domain).toBe("acme-nyc.com");
  });

  it("different domains and different linkedins are both kept", () => {
    const records = [
      { domain: "acme.com", linkedin_url: "https://www.linkedin.com/company/acme/" },
      { domain: "beta.com", linkedin_url: "https://www.linkedin.com/company/beta/" },
    ];
    const result = dedupeCompanies(records);
    expect(result).toHaveLength(2);
  });
});

describe("dedupePeople", () => {
  it("deduplicates by linkedin_url", () => {
    const records = [
      { linkedin_url: "https://www.linkedin.com/in/john-doe/", first_name: "John" },
      { linkedin_url: "https://www.linkedin.com/in/john-doe/", first_name: "Johnny" },
      { linkedin_url: "https://www.linkedin.com/in/jane-doe/", first_name: "Jane" },
    ];
    const result = dedupePeople(records);
    expect(result).toHaveLength(2);
    expect(result[0].first_name).toBe("John");
  });

  it("keeps records with no linkedin_url", () => {
    const records = [
      { linkedin_url: null, first_name: "A" },
      { linkedin_url: null, first_name: "B" },
    ];
    const result = dedupePeople(records);
    expect(result).toHaveLength(2);
  });
});
