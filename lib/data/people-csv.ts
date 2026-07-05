import type { PersonExportRow, PersonListFilters } from "@/lib/data/people";
import { getAllFilteredPeopleForExport } from "@/lib/data/people";
import { buildCsv, stringifyCsvValue } from "@/lib/data/csv";

const FIXED_HEADERS = [
  "Full Name",
  "Job Title",
  "Email",
  "Email Status",
  "Phone",
  "Phone Type",
  "LinkedIn URL",
  "Company",
  "Company Domain",
  "Company LinkedIn URL",
  "City",
  "State",
  "Country",
  "Source",
  "Tags",
  "Last Updated",
];

function toRecord(row: PersonExportRow): Record<string, string> {
  const record: Record<string, string> = {
    "Full Name": row.fullName ?? "",
    "Job Title": row.jobTitle ?? "",
    Email: row.email ?? "",
    "Email Status": row.emailStatus ?? "",
    Phone: row.phone ?? "",
    "Phone Type": row.phoneType ?? "",
    "LinkedIn URL": row.linkedinUrl ?? "",
    Company: row.companyName ?? "",
    "Company Domain": row.domain ?? "",
    "Company LinkedIn URL": row.companyLinkedinUrl ?? "",
    City: row.city ?? "",
    State: row.state ?? "",
    Country: row.country ?? "",
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
