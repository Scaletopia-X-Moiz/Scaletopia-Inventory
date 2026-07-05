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
      "Company Website": "ignore",
      "Company Domain": "domain",
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
    },
    // Store Leads is storefront/e-commerce data, not person data, so this
    // is left thin; unlocking the toggle still allows manual mapping.
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
  "blitz",
  "apollo",
  "google-maps",
  "store-leads",
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
