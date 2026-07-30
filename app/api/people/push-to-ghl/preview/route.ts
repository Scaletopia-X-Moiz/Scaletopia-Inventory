import type { NextRequest } from "next/server";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { getPeopleForGhl } from "@/lib/data/people";
import { splitGhlEligibility } from "@/lib/ghl/push-to-ghl";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** Resolves the current filtered People view's eligible/skipped-landline
 * counts ahead of the actual push, so the GHL confirm screen can show them
 * before the user commits — the push route/engine itself only reports these
 * numbers in the final done event, not up front. */
export async function GET(request: NextRequest) {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const filters = parsePersonFilters(request.nextUrl.searchParams);
  const candidates = await getPeopleForGhl(filters);
  const { total_matched, eligible, skipped } = splitGhlEligibility(candidates);

  return Response.json({ total_matched, eligible: eligible.length, skipped });
}
