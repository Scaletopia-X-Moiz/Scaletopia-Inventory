import type { NextRequest } from "next/server";
import { exportCompaniesCsv } from "@/lib/data/companies-csv";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";
import { getUser } from "@/lib/auth/dal";
import { logActivity } from "@/lib/activity/log";

export async function GET(request: NextRequest) {
  const user = await getUser();
  const filters = parseCompanyFilters(request.nextUrl.searchParams);
  const csv = await exportCompaniesCsv(filters);
  // Header line + one line per row, no trailing newline (see buildCsv).
  const rowCount = csv.length === 0 ? 0 : csv.split("\n").length - 1;

  await logActivity("companies.export", { rowCount, filters }, user ?? undefined);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="companies.csv"',
    },
  });
}
