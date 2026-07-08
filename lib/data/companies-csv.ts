import type { CompanyExportRow, CompanyListFilters } from "@/lib/data/companies";
import { getAllFilteredCompaniesForExport } from "@/lib/data/companies";
import { buildCsv, stringifyCsvValue } from "@/lib/data/csv";

const FIXED_HEADERS = [
  "Company Name",
  "Brand Name",
  "Domain",
  "Website URL",
  "LinkedIn URL",
  "Niche",
  "Industry",
  "Employees",
  "City",
  "State",
  "Country",
  "Phone",
  "Phone Type",
  "Phone Status",
  "Phone Verified At",
  "Email",
  "Email Status",
  "Email Verified At",
  "Description",
  "Founded Year",
  "Revenue",
  "Client",
  "Source",
  "Quality Tier",
  "Domain Status",
  "MX Provider",
  "Security Gateway",
  "Keywords",
  "Technologies",
  "Tags",
  "Last Updated",
];

function toRecord(row: CompanyExportRow): Record<string, string> {
  const record: Record<string, string> = {
    "Company Name": row.companyName ?? "",
    "Brand Name": row.brandName ?? "",
    Domain: row.domain ?? "",
    "Website URL": row.websiteUrl ?? "",
    "LinkedIn URL": row.linkedinUrl ?? "",
    Niche: row.niche ?? "",
    Industry: row.industry ?? "",
    Employees: row.employeeCount?.toString() ?? "",
    City: row.city ?? "",
    State: row.state ?? "",
    Country: row.country ?? "",
    Phone: row.phone ?? "",
    "Phone Type": row.phoneType ?? "",
    "Phone Status": row.phoneStatus ?? "",
    "Phone Verified At": row.phoneVerifiedAt ?? "",
    Email: row.email ?? "",
    "Email Status": row.emailStatus ?? "",
    "Email Verified At": row.emailVerifiedAt ?? "",
    Description: row.description ?? "",
    "Founded Year": row.foundedYear?.toString() ?? "",
    Revenue: row.revenue?.toString() ?? "",
    Client: row.client ?? "",
    Source: row.sources.join(", "),
    "Quality Tier": row.qualityTier ?? "",
    "Domain Status": row.domainStatus ?? "",
    "MX Provider": row.mxProvider ?? "",
    "Security Gateway": row.securityGateway ?? "",
    Keywords: row.keywords.join(", "),
    Technologies: row.technologies.join(", "),
    Tags: row.tags.join(", "),
    "Last Updated": row.lastUpdated ?? "",
  };

  for (const [key, value] of Object.entries(row.customData)) {
    record[key] = stringifyCsvValue(value);
  }

  return record;
}

export async function exportCompaniesCsv(filters: CompanyListFilters): Promise<string> {
  const rows = await getAllFilteredCompaniesForExport(filters);
  return buildCsv(FIXED_HEADERS, rows.map(toRecord));
}
