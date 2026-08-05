import type { NextRequest } from "next/server";
import { getPersonPushStatusCounts } from "@/lib/data/people";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { asPushPlatform } from "@/lib/data/push-status-filter";

/** Live push-status preview counts for the People popover (E1, issue #133).
 *
 * The current filter set arrives as the same URL params the list uses, so the
 * counts are scoped to the active view; `clientId` + `platform` carry the
 * popover's (possibly uncommitted) draft selection. Any active push-status
 * params in the URL are self-excluded — the RPC ignores the pushStatus key —
 * so the two counts always sum to the total that selection would yield.
 *
 * Returns zeroed counts (not an error) until a valid client + platform are
 * chosen, so the client can render the loading/empty state uniformly. */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const clientId = sp.get("clientId");
  const platform = asPushPlatform(sp.get("platform"));
  if (!clientId || !platform) {
    return Response.json({ pushed: 0, notPushed: 0 });
  }
  const filters = parsePersonFilters(sp);
  const counts = await getPersonPushStatusCounts(filters, clientId, platform);
  return Response.json(counts);
}
