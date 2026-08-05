import type { NextRequest } from "next/server";
import { getCompanyPushStatusCounts } from "@/lib/data/companies";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";
import { asPushPlatform } from "@/lib/data/push-status-filter";

/** Live push-status preview counts for the Companies popover (E1, issue #133).
 *
 * Companies twin of app/api/people/push-status-counts — same contract, "has
 * work left" semantics (a company is not-yet-pushed iff any linked contact
 * still needs pushing). The current filter set arrives as the list's URL
 * params so counts stay scoped to the active view; `clientId` + `platform`
 * carry the popover's draft selection; active push-status params are
 * self-excluded by the RPC. */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const clientId = sp.get("clientId");
  const platform = asPushPlatform(sp.get("platform"));
  if (!clientId || !platform) {
    return Response.json({ pushed: 0, notPushed: 0 });
  }
  const filters = parseCompanyFilters(sp);
  const counts = await getCompanyPushStatusCounts(filters, clientId, platform);
  return Response.json(counts);
}
