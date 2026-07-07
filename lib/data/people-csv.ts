import type { PersonExportRow, PersonListFilters } from "@/lib/data/people";
import { getAllFilteredPeopleForExport } from "@/lib/data/people";
import { buildCsv, stringifyCsvValue } from "@/lib/data/csv";

const FIXED_HEADERS = [
  "First Name",
  "Last Name",
  "Full Name",
  "Job Title",
  "Email",
  "Email Status",
  "Email Verified At",
  "Phone",
  "Phone Type",
  "Phone Status",
  "Phone Verified At",
  "LinkedIn URL",
  "LinkedIn Username",
  "Company",
  "Company Domain",
  "Company LinkedIn URL",
  "City",
  "State",
  "Country",
  "Source ID",
  "Source",
  "Tags",
  "Last Updated",
];

function toRecord(row: PersonExportRow): Record<string, string> {
  const record: Record<string, string> = {
    "First Name": row.firstName ?? "",
    "Last Name": row.lastName ?? "",
    "Full Name": row.fullName ?? "",
    "Job Title": row.jobTitle ?? "",
    Email: row.email ?? "",
    "Email Status": row.emailStatus ?? "",
    "Email Verified At": row.emailVerifiedAt ?? "",
    Phone: row.phone ?? "",
    "Phone Type": row.phoneType ?? "",
    "Phone Status": row.phoneStatus ?? "",
    "Phone Verified At": row.phoneVerifiedAt ?? "",
    "LinkedIn URL": row.linkedinUrl ?? "",
    "LinkedIn Username": row.linkedinUsername ?? "",
    Company: row.companyName ?? "",
    "Company Domain": row.domain ?? "",
    "Company LinkedIn URL": row.companyLinkedinUrl ?? "",
    City: row.city ?? "",
    State: row.state ?? "",
    Country: row.country ?? "",
    "Source ID": row.sourceId ?? "",
    Source: row.sources.join(", "),
    Tags: row.tags.join(", "),
    "Last Updated": row.lastUpdated ?? "",
  };

  for (const [key, value] of Object.entries(row.customData)) {
    record[key] = stringifyCsvValue(value);
  }

  return record;
}

export async function exportPeopleCsv(filters: PersonListFilters): Promise<string> {
  const rows = await getAllFilteredPeopleForExport(filters);
  return buildCsv(FIXED_HEADERS, rows.map(toRecord));
}
