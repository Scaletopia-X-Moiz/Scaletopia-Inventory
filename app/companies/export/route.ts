import type { NextRequest } from "next/server";
import { exportCompaniesCsv } from "@/lib/data/companies-csv";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";
import { getUser } from "@/lib/auth/dal";
import { logActivity } from "@/lib/activity/log";

export async function GET(request: NextRequest) {
  const user = await getUser();
  const filters = parseCompanyFilters(request.nextUrl.searchParams);
  const csv = await exportCompaniesCsv(filters);
  // buildCsv terminates every line (including the last) with "\n", so the
  // number of newline characters equals the header line plus every data row.
  const rowCount = csv.length === 0 ? 0 : (csv.match(/\n/g)?.length ?? 0) - 1;

  await logActivity("companies.export", { rowCount, filters }, user ?? undefined);

  return new Response(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="companies.csv"',
    },
  });
}
