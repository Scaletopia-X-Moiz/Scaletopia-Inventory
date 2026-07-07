export type TargetTable = "companies" | "people";

export interface ProviderPreset {
  sourceKey: string;
  displayName: string;
  targetTable: TargetTable;
  columnMap: Record<string, string>;
  // Column map for the *other* table (people, if targetTable is companies;
  // companies, if targetTable is people). Presence of this field is what
  // unlocks the Companies/People toggle for a builtin provider in the UI.
  altColumnMap?: Record<string, string>;
  // When the CURRENT effective target table is "people" (whether because
  // targetTable is "people", or the user toggled to People for a
  // companies-primary preset), this optional map extracts embedded company
  // columns from the SAME rows, so one CSV populates both tables in a single
  // linked push (see app/import/page.tsx "company sync" toggle).
  companyColumnMap?: Record<string, string>;
  // Pre-check the "this file also contains company data" toggle when this
  // preset is selected and the effective table is People.
  companySyncDefault?: boolean;
}

export const BUILTIN_PROVIDERS: ProviderPreset[] = [
  {
    sourceKey: "aiark",
    displayName: "AI Ark",
    targetTable: "companies",
    // Verified against a real "AI Ark Company.csv" export.
    columnMap: {
      "Company Name": "company_name",
      "Website": "website_url",
      "LinkedIn": "linkedin_url",
      "Industry": "industry",
      "Description": "description",
      "Headcount": "employee_count",
      "Company City": "city",
      "Company State": "state",
      "Company Country": "country",
      "Primary Company Phone": "phone",
      "Founding Year": "founded_year",
      "Annual Revenue": "revenue",
      "Technologies": "technologies",
    },
    // Verified against a real "AI Ark People.csv" export. This file is a
    // person+company join — every row repeats the employer's full company
    // record under "Company *" headers. Several of those (Company City,
    // Company State, Company Country, Company Primary Phone, Company Email,
    // Company LinkedIn) are near-duplicates of real person-field names and
    // the fuzzy matcher would otherwise substring-match them onto the
    // person's own city/state/country/phone/email/linkedin_url — and since
    // they appear later in the CSV than the correct person columns, they'd
    // silently overwrite the correct values. Every column is mapped
    // explicitly here (including deliberate "ignore"s) so nothing is left
    // to fuzzy-match order-dependent luck. The "Company *" fields belong to
    // the companies table, not this person row — they're intentionally
    // dropped here; the company side is imported/updated separately and
    // linked via company_id (see lib/import/push.ts).
    altColumnMap: {
      "First Name": "first_name",
      "Last Name": "last_name",
      "Full Name": "full_name",
      "Title": "job_title",
      "Organization": "company_name",
      "Email Provider": "ignore",
      "Email Business": "email",
      "Business Status": "ignore",
      "Domain Settings": "ignore",
      "Mobile Phone": "phone",
      "Location": "ignore",
      "Country": "country",
      "State": "state",
      "City": "city",
      "Seniority": "custom_data",
      "Department": "custom_data",
      "LinkedIn": "linkedin_url",
      "Last Updated": "custom_data",
      "AI Ark People ID": "source_id",
      "Company Name": "company_name",
      "Company Size": "ignore",
      "Company Total headcount growth (3 months)": "ignore",
      "Company Total headcount growth (6 months)": "ignore",
      "Company Total headcount growth (12 months)": "ignore",
      "Company Total headcount growth (24 months)": "ignore",
      "Company Industry": "ignore",
      "Company Product and Services": "ignore",
      "Company Description": "ignore",
      "Company SEO Description": "ignore",
      // BUG: real AI Ark People.csv exports have "Company Domain" empty on
      // every row (verified against testcsv/AI Ark People.csv); the actual
      // bare domain (e.g. "teminc.com", no protocol) lives in "Company
      // Website" instead. Map "Company Domain" first (so it wins if a future
      // export ever populates it) and "Company Website" second as the
      // fallback that actually has data today — mapRow's first-non-empty-wins
      // scalar guard makes this ordering safe.
      "Company Domain": "domain",
      "Company Website": "domain",
      "Company LinkedIn": "ignore",
      "Company X (Twitter)": "ignore",
      "Company Facebook": "ignore",
      "Company Instagram": "ignore",
      "Company Type": "ignore",
      "Company Number Of Locations": "ignore",
      "Company Location": "ignore",
      "Company Country": "ignore",
      "Company State": "ignore",
      "Company City": "ignore",
      "Company Primary Phone": "ignore",
      "Company Email": "ignore",
      "Company Founding Year": "ignore",
      "Company Annual Revenue": "ignore",
      "Company Total Funding": "ignore",
      "Company Last Funding Type": "ignore",
      "Company Last Funding Amount": "ignore",
      "Company Last Funding Date": "ignore",
      "Company AI Ark account ID": "ignore",
      "Company Last Updated": "ignore",
    },
    // Extracts the same "Company *" headers that `altColumnMap` above
    // deliberately ignores, but as COMPANY-table fields instead — this is
    // what powers the "this file also contains company data" sync toggle.
    // Fields with no dedicated companies column (funding history, social
    // handles, growth metrics, internal IDs) fall through to custom_data so
    // nothing is lost.
    companyColumnMap: {
      "Company Name": "company_name",
      "Company Size": "employee_count",
      "Company Total headcount growth (3 months)": "custom_data",
      "Company Total headcount growth (6 months)": "custom_data",
      "Company Total headcount growth (12 months)": "custom_data",
      "Company Total headcount growth (24 months)": "custom_data",
      "Company Industry": "industry",
      "Company Product and Services": "custom_data",
      "Company Description": "description",
      "Company SEO Description": "custom_data",
      // Same real-data gap as altColumnMap above: "Company Domain" is empty
      // on every row of the actual export, "Company Website" holds the real
      // bare domain. Domain first (wins if ever populated), Website second
      // as the fallback that actually carries data today.
      "Company Domain": "domain",
      "Company Website": "domain",
      "Company LinkedIn": "linkedin_url",
      "Company X (Twitter)": "custom_data",
      "Company Facebook": "custom_data",
      "Company Instagram": "custom_data",
      "Company Type": "custom_data",
      "Company Number Of Locations": "custom_data",
      "Company Location": "custom_data",
      "Company Country": "country",
      "Company State": "state",
      "Company City": "city",
      "Company Primary Phone": "phone",
      "Company Email": "email",
      "Company Founding Year": "founded_year",
      "Company Annual Revenue": "revenue",
      "Company Total Funding": "custom_data",
      "Company Last Funding Type": "custom_data",
      "Company Last Funding Amount": "custom_data",
      "Company Last Funding Date": "custom_data",
      "Company AI Ark account ID": "custom_data",
      "Company Last Updated": "custom_data",
    },
    companySyncDefault: true,
  },
  {
    sourceKey: "external-scraper",
    displayName: "External Scraper",
    targetTable: "people",
    // Verified against a real "External Scraper People.csv" export. This
    // file is a person+company join like AI Ark's People export, but its
    // duplication style is different: rather than a single "Company *"
    // prefix, several PERSON fields are simply repeated verbatim later in
    // the row under a "_1"-suffixed header (e.g. "First Name" then
    // "First Name_1"), and "Company Name" is likewise repeated as
    // "Company Name_1" once the row reaches the actual company data block.
    // Confirmed by inspecting a real row: "Company Name" (col 0, the
    // person's employer name) and "Company Name_1" (in the company block)
    // hold the identical string for a given row — so both are legitimate,
    // but only one may be mapped per target to avoid the same
    // exact-header-wins/first-non-empty-wins ordering hazard described in
    // the AI Ark comment above. The "_1" columns are explicitly ignored
    // here (not left to fuzzy-match) since they are pure duplicates of the
    // earlier, correct columns.
    columnMap: {
      "Company Name": "company_name",
      "Domain": "domain",
      "First Name": "first_name",
      "Last Name": "last_name",
      "Job Title": "job_title",
      "Person Linkedin Url": "linkedin_url",
      "Mobile Phone": "phone",
      "Other Phone": "custom_data",
      "First Name_1": "ignore",
      "Last Name_1": "ignore",
      "Title": "ignore",
      "Person Linkedin Url_1": "ignore",
      "City": "city",
      "State": "state",
      "Country": "country",
      "Email": "email",
      "Company Name_1": "ignore",
      "Website": "ignore",
      "Industry": "ignore",
      "# Employees": "ignore",
      "Annual Revenue": "ignore",
      "Total Funding": "ignore",
      "Company Phone": "ignore",
      "Company Linkedin Url": "ignore",
      "Company Street": "ignore",
      "Company City": "ignore",
      "Company Postal Code": "ignore",
      "Company State": "ignore",
      "Company Country": "ignore",
      "Company Founded Year": "ignore",
    },
    // Extracts the embedded company block for the sync toggle. "Company
    // Name_1" (not the earlier "Company Name") is the identity choice here
    // since it sits inside the actual company-data block alongside Website/
    // Industry/# Employees/etc — the earlier "Company Name" belongs to the
    // person side above and is left "ignore" here to avoid double-mapping.
    companyColumnMap: {
      "Company Name": "ignore",
      "Domain": "domain",
      "Company Name_1": "company_name",
      "Website": "website_url",
      "Industry": "industry",
      "# Employees": "employee_count",
      "Annual Revenue": "revenue",
      "Total Funding": "custom_data",
      "Company Phone": "phone",
      "Company Linkedin Url": "linkedin_url",
      "Company Street": "custom_data",
      "Company City": "city",
      "Company Postal Code": "custom_data",
      "Company State": "state",
      "Company Country": "country",
      "Company Founded Year": "founded_year",
    },
    companySyncDefault: true,
  },
  {
    sourceKey: "apollo",
    displayName: "Apollo",
    targetTable: "companies",
    columnMap: {
      "Company": "company_name",
      "Company Name": "company_name",
      "Website": "website_url",
      "Company LinkedIn Url": "linkedin_url",
      "# Employees": "employee_count",
      "Industry": "industry",
      "City": "city",
      "State": "state",
      "Country": "country",
      "Corporate Phone": "phone",
    },
    // Inferred from a real Apollo-style contacts export ("External Scraper
    // People.csv") using the same "# Employees" / "Person Linkedin Url"
    // naming convention as Apollo's own company export.
    altColumnMap: {
      "Company Name": "company_name",
      "Domain": "domain",
      "First Name": "first_name",
      "Last Name": "last_name",
      "Job Title": "job_title",
      "Person Linkedin Url": "linkedin_url",
      "Mobile Phone": "phone",
      "City": "city",
      "State": "state",
      "Country": "country",
      "Email": "email",
    },
  },
  {
    sourceKey: "blitz",
    displayName: "Blitz",
    targetTable: "companies",
    columnMap: {
      "Company Name": "company_name",
      "Domain": "domain",
      "LinkedIn": "linkedin_url",
      "Website": "website_url",
      "Industry": "industry",
      "Employees": "employee_count",
      "City": "city",
      "State": "state",
      "Country": "country",
      "Phone": "phone",
    },
    // Inferred (no real Blitz people export on hand) using the same header
    // style as Blitz's own company export.
    altColumnMap: {
      "Full Name": "full_name",
      "First Name": "first_name",
      "Last Name": "last_name",
      "Job Title": "job_title",
      "Email": "email",
      "LinkedIn": "linkedin_url",
      "Company Name": "company_name",
      "Domain": "domain",
      "City": "city",
      "State": "state",
      "Country": "country",
      "Phone": "phone",
    },
  },
  {
    sourceKey: "google-maps",
    displayName: "Google Maps",
    targetTable: "companies",
    // Verified against a real OutScraper Google Maps export
    // ("OutScraper Google Maps Company.xlsx").
    columnMap: {
      "name": "company_name",
      "website": "website_url",
      "phone": "phone",
      "city": "city",
      "state": "state",
      "country": "country",
      "category": "industry",
      "company_insights.employees": "employee_count",
      "company_insights.revenue": "revenue",
      "company_insights.founded_year": "founded_year",
      "company_insights.industry": "industry",
    },
    // Google Maps place listings don't carry person-level data, so this is
    // left thin; unlocking the toggle still lets a user map a blended
    // export (e.g. an "owner" field) by hand.
    altColumnMap: {},
  },
  {
    sourceKey: "clay",
    displayName: "Clay",
    targetTable: "companies",
    columnMap: {
      "Company Name": "company_name",
      "Domain": "domain",
      "LinkedIn URL": "linkedin_url",
      "Website": "website_url",
      "Industry": "industry",
      "Employees": "employee_count",
      "City": "city",
      "State": "state",
      "Country": "country",
    },
    // Inferred (no real Clay people export on hand) using the same header
    // style as Clay's own company export.
    altColumnMap: {
      "Full Name": "full_name",
      "First Name": "first_name",
      "Last Name": "last_name",
      "Job Title": "job_title",
      "Email": "email",
      "LinkedIn URL": "linkedin_url",
      "Company Name": "company_name",
      "Domain": "domain",
      "City": "city",
      "State": "state",
      "Country": "country",
    },
  },
  {
    sourceKey: "store-leads",
    displayName: "Store Leads",
    targetTable: "companies",
    // Verified against a real "Storeleads Company.csv" export (lowercase
    // snake_case headers).
    columnMap: {
      "domain": "domain",
      "merchant_name": "company_name",
      "city": "city",
      "state": "state",
      "country_code": "country",
      "description": "description",
      "employee_count": "employee_count",
      "linkedin_url": "linkedin_url",
      "emails": "email",
      "phones": "phone",
      "technologies": "technologies",
      "estimated_yearly_sales": "revenue",
      // `meta_keywords` is a clean comma-separated keyword list; `categories`
      // is a rich but taxonomy-formatted field ("/Food & Drink/Food/Snack
      // Foods:/...") so it is preserved in custom_data rather than split into
      // keywords. Explicitly DO NOT map `platform_domain` / `cluster_domains` /
      // `domain_count` etc. onto `domain` — they overwrite the real domain.
      "meta_keywords": "keywords",
      "categories": "custom_data",
      "tiktok": "custom_data",
    },
    // Store Leads is storefront/e-commerce data, not person data, so this
    // is left thin; unlocking the toggle still allows manual mapping.
    altColumnMap: {},
  },
  {
    sourceKey: "leadfox",
    displayName: "LeadFox",
    targetTable: "companies",
    // Verified against a real "MyLeadFox Company.csv" export. `Website` is a
    // bare domain (no protocol, e.g. "audioelite.it"), so it maps to `domain`
    // (the identity field) rather than `website_url`.
    columnMap: {
      "Website": "domain",
      "Name": "company_name",
      "Description": "description",
      "Shop Category": "industry",
      "Email": "email",
      "Phone Number": "phone",
      "City": "city",
      "State": "state",
      "Country": "country",
      "Est. Monthly Sales": "revenue",
      "Technology Used": "technologies",
      "Keywords": "keywords",
      "LinkedIn": "linkedin_url",
      // Storefront/social metadata with no dedicated column — preserved
      // rather than dropped.
      "Est. Products Sold": "custom_data",
      "Platform": "custom_data",
      "Plan": "custom_data",
      "Theme": "custom_data",
      "Installed Apps": "custom_data",
      "Est Monthly Page Views": "custom_data",
      "Est Monthly Visits": "custom_data",
      "Shipping Partners": "custom_data",
      "Facebook": "custom_data",
      "Instagram": "custom_data",
      "Twitter": "custom_data",
      "Twitter Followers": "custom_data",
      "Twitter Posts": "custom_data",
      "YouTube": "custom_data",
      "YouTube Followers": "custom_data",
      "Pinterest": "custom_data",
      "Pinterest Followers": "custom_data",
      "Pinterest Posts": "custom_data",
      "Tiktok": "custom_data",
      "Tiktok Followers": "custom_data",
      "Lang": "custom_data",
      // "Enrichment" is an internal LeadFox marker ("Enrich|<domain>"), not
      // real data.
      "Enrichment": "ignore",
    },
    // LeadFox is storefront/e-commerce data, not person data, so this is
    // left thin; unlocking the toggle still allows manual mapping.
    altColumnMap: {},
  },
  {
    sourceKey: "builtwith",
    displayName: "BuiltWith",
    targetTable: "companies",
    // Verified against a real "Builtwith Company.csv" export.
    columnMap: {
      "Root Domain": "domain",
      "Company": "company_name",
      "Employees": "employee_count",
      "Vertical": "niche",
      "Sales Revenue": "revenue",
      "City": "city",
      "State": "state",
      "Country": "country",
    },
    // BuiltWith is a technology-profiling tool with no person-level export;
    // left thin, but unlocked per request.
    altColumnMap: {},
  },
  {
    sourceKey: "clutch",
    displayName: "Clutch",
    targetTable: "companies",
    columnMap: {
      "Company": "company_name",
      "Website": "website_url",
      "Location": "city",
      "Employees": "employee_count",
      "Description": "description",
    },
    // Clutch is an agency directory with no person-level export; left
    // thin, but unlocked per request.
    altColumnMap: {},
  },
  {
    sourceKey: "crunchbase",
    displayName: "Crunchbase",
    targetTable: "companies",
    columnMap: {
      "Organization Name": "company_name",
      "Website": "website_url",
      "LinkedIn": "linkedin_url",
      "Number of Employees": "employee_count",
      "Industry": "industry",
      "City": "city",
      "Country": "country",
      "Founded Year": "founded_year",
      "Description": "description",
    },
    // Inferred from Crunchbase's "People" export naming convention (no
    // real sample on hand).
    altColumnMap: {
      "Full Name": "full_name",
      "First Name": "first_name",
      "Last Name": "last_name",
      "Job Title": "job_title",
      "Email": "email",
      "LinkedIn": "linkedin_url",
      "Organization Name": "company_name",
      "City": "city",
      "Country": "country",
    },
  },
  {
    sourceKey: "yelp",
    displayName: "Yelp",
    targetTable: "companies",
    columnMap: {
      "Business Name": "company_name",
      "Website": "website_url",
      "Phone": "phone",
      "City": "city",
      "State": "state",
      "Country": "country",
    },
    // Yelp business listings have no person-level export; left thin, but
    // unlocked per request.
    altColumnMap: {},
  },
  {
    sourceKey: "salesnav",
    displayName: "Sales Navigator",
    targetTable: "people",
    columnMap: {
      "Full Name": "full_name",
      "First Name": "first_name",
      "Last Name": "last_name",
      "Job Title": "job_title",
      "Email": "email",
      "LinkedIn Profile URL": "linkedin_url",
      "Company": "company_name",
      "City": "city",
      "Country": "country",
    },
    // Inferred from a LinkedIn Sales Navigator *account/company* search
    // export (the counterpart to its people search export).
    altColumnMap: {
      "Company Name": "company_name",
      "Website": "website_url",
      "Industry": "industry",
      "Location": "city",
    },
  },
  {
    sourceKey: "manual-csv",
    displayName: "Manual CSV",
    targetTable: "companies",
    columnMap: {},
    altColumnMap: {},
  },
];

export const CANONICAL_SOURCE_KEYS = [
  "aiark",
  "external-scraper",
  "blitz",
  "apollo",
  "google-maps",
  "store-leads",
  "leadfox",
  "builtwith",
  "clutch",
  "crunchbase",
  "yelp",
  "salesnav",
  "manual-csv",
] as const;

export const COMPANIES_FIELDS: string[] = [
  "company_name",
  "domain",
  "website_url",
  "linkedin_url",
  "industry",
  "city",
  "state",
  "country",
  "employee_count",
  "phone",
  "email",
  "description",
  "founded_year",
  "revenue",
  "niche",
  "keywords",
  "technologies",
  "custom_data",
];

export const PEOPLE_FIELDS: string[] = [
  "first_name",
  "last_name",
  "full_name",
  "email",
  "phone",
  "job_title",
  "linkedin_url",
  "linkedin_username",
  "city",
  "state",
  "country",
  "company_name",
  "domain",
  "email_status",
  "phone_type",
  "custom_data",
  "source_id",
];

export const COLUMN_ALIASES: Record<string, string> = {
  website: "website_url",
  "website url": "website_url",
  url: "website_url",
  company: "company_name",
  "company name": "company_name",
  name: "company_name",
  organization: "company_name",
  linkedin: "linkedin_url",
  "linkedin url": "linkedin_url",
  employees: "employee_count",
  "employee count": "employee_count",
  size: "employee_count",
  "company size": "employee_count",
  headcount: "employee_count",
  "first name": "first_name",
  "last name": "last_name",
  "full name": "full_name",
  "job title": "job_title",
  title: "job_title",
  position: "job_title",
  "email address": "email",
  emails: "email",
  "phone number": "phone",
  founded: "founded_year",
  "year founded": "founded_year",
  vertical: "niche",
  sector: "industry",
};
