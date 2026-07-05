export function normalizeDomain(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let d = raw.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  const slashIdx = d.indexOf("/");
  if (slashIdx !== -1) d = d.slice(0, slashIdx);
  d = d.replace(/\/$/, "");
  return d || null;
}

export function normalizeLinkedInUrl(raw: string | null | undefined): string | null {
  if (!raw || !raw.trim()) return null;
  let u = raw.trim().toLowerCase();
  u = u.replace(/^https?:\/\//, "");
  u = u.replace(/^(www\.)?linkedin\.com/, "linkedin.com");
  const qIdx = u.indexOf("?");
  if (qIdx !== -1) u = u.slice(0, qIdx);
  u = u.replace(/\/$/, "");
  if (!u.startsWith("linkedin.com/")) return null;
  return `https://www.${u}/`;
}

export const JUNK_DOMAINS = new Set([
  "facebook.com",
  "yelp.com",
  "wix.com",
  "squarespace.com",
  "wordpress.com",
  "blogspot.com",
  "linkedin.com",
  "twitter.com",
  "instagram.com",
  "youtube.com",
  "tiktok.com",
  "pinterest.com",
  "shopify.com",
  "etsy.com",
  "amazon.com",
  "google.com",
  "apple.com",
  "microsoft.com",
]);

export function scrubJunkDomain(domain: string | null): string | null {
  if (!domain) return null;
  return JUNK_DOMAINS.has(domain) ? null : domain;
}

const COLUMN_ALIAS_MAP: Record<string, string> = {
  website: "website_url",
  "website url": "website_url",
  url: "website_url",
  company: "company_name",
  "company name": "company_name",
  name: "company_name",
  organization: "company_name",
  org: "company_name",
  linkedin: "linkedin_url",
  "linkedin url": "linkedin_url",
  "linkedin profile": "linkedin_url",
  employees: "employee_count",
  "employee count": "employee_count",
  "number of employees": "employee_count",
  size: "employee_count",
  "company size": "employee_count",
  headcount: "employee_count",
  "first name": "first_name",
  firstname: "first_name",
  "last name": "last_name",
  lastname: "last_name",
  "full name": "full_name",
  fullname: "full_name",
  "job title": "job_title",
  title: "job_title",
  position: "job_title",
  role: "job_title",
  "email address": "email",
  emails: "email",
  "phone number": "phone",
  tel: "phone",
  telephone: "phone",
  "linkedin username": "linkedin_username",
  founded: "founded_year",
  "year founded": "founded_year",
  "founding year": "founded_year",
  hq: "city",
  location: "city",
  "hq city": "city",
  "hq country": "country",
  "hq state": "state",
  desc: "description",
  about: "description",
  vertical: "niche",
  sector: "industry",
};

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s\-_]+/g, "");
}

/**
 * Many providers export "joined" CSVs — one row per person, with the
 * employer's entire company record repeated under prefixed headers (e.g.
 * AI Ark's people export has both "City" (the person's) and "Company City"
 * (the employer's)). Left unguarded, the fuzzy matcher's substring scoring
 * (and the alias table) happily matches "Company City" -> city, "Company
 * Email" -> email, etc. — and because these columns tend to sit later in
 * the CSV than the real person columns, they silently overwrite the correct
 * value. This table lists the prefixes that mark a column as describing the
 * *other* entity for a given import target, so those columns are excluded
 * from matching that target's own identity fields.
 */
const CROSS_ENTITY_PREFIXES: Record<string, string[]> = {
  people: ["company ", "organization ", "employer ", "account "],
  companies: ["contact ", "person ", "employee "],
};

/**
 * Fields that legitimately cross-reference the *other* entity and are
 * exempt from the cross-entity prefix exclusion above — e.g. a person row
 * is meant to carry their employer's `company_name`/`domain`, so
 * "Company Name" / "Company Domain" should still be allowed to match those
 * two fields specifically, just not `city`, `phone`, `email`, etc.
 */
const CROSS_REFERENCE_FIELDS: Record<string, string[]> = {
  people: ["company_name", "domain"],
  companies: [],
};

export function fuzzyMatchColumn(
  header: string,
  candidates: string[],
  targetTable?: "companies" | "people"
): { field: string; score: number } | null {
  const lower = header.toLowerCase();
  const normalized = normalizeHeader(header);

  const foreignPrefixes = targetTable ? CROSS_ENTITY_PREFIXES[targetTable] : [];
  const hasForeignPrefix = foreignPrefixes.some((p) => lower.startsWith(p));
  const exemptFields = targetTable ? CROSS_REFERENCE_FIELDS[targetTable] : [];
  const isAllowed = (field: string) => !hasForeignPrefix || exemptFields.includes(field);

  const aliasResult = COLUMN_ALIAS_MAP[lower] ?? COLUMN_ALIAS_MAP[normalized];
  if (aliasResult && candidates.includes(aliasResult) && isAllowed(aliasResult)) {
    return { field: aliasResult, score: 0.95 };
  }

  let best: { field: string; score: number } | null = null;

  for (const candidate of candidates) {
    if (!isAllowed(candidate)) continue;

    let score = 0;
    const candLower = candidate.toLowerCase();
    const candNorm = normalizeHeader(candidate);

    if (header === candidate) {
      score = 1.0;
    } else if (lower === candLower) {
      score = 0.9;
    } else if (normalized === candNorm) {
      score = 0.8;
    } else if (candLower.includes(lower) || lower.includes(candLower)) {
      score = 0.5;
    }

    if (score > 0 && (!best || score > best.score)) {
      best = { field: candidate, score };
    }
  }

  if (!best || best.score < 0.4) return null;
  return best;
}

export function dedupeCompanies(
  records: Record<string, unknown>[]
): Record<string, unknown>[] {
  const seenDomain = new Set<string>();
  const seenLinkedin = new Set<string>();
  const result: Record<string, unknown>[] = [];

  for (const rec of records) {
    const domain = typeof rec.domain === "string" ? rec.domain : null;
    const linkedin =
      typeof rec.linkedin_url === "string" ? rec.linkedin_url : null;

    if (domain) {
      if (seenDomain.has(domain)) continue;
      seenDomain.add(domain);
      if (linkedin) seenLinkedin.add(linkedin);
      result.push(rec);
    } else if (linkedin) {
      if (seenLinkedin.has(linkedin)) continue;
      seenLinkedin.add(linkedin);
      result.push(rec);
    } else {
      result.push(rec);
    }
  }

  return result;
}

export function dedupePeople(
  records: Record<string, unknown>[]
): Record<string, unknown>[] {
  const seenLinkedin = new Set<string>();
  const seenEmail = new Set<string>();
  const result: Record<string, unknown>[] = [];

  for (const rec of records) {
    const linkedin =
      typeof rec.linkedin_url === "string" ? rec.linkedin_url : null;
    const email = typeof rec.email === "string" ? rec.email.toLowerCase() : null;

    if (linkedin && seenLinkedin.has(linkedin)) continue;
    if (email && seenEmail.has(email)) continue;

    if (linkedin) seenLinkedin.add(linkedin);
    if (email) seenEmail.add(email);
    result.push(rec);
  }

  return result;
}
