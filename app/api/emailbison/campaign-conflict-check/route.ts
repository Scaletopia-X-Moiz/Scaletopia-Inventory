import type { NextRequest } from "next/server";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";
import { getClientById } from "@/lib/data/clients";
import { checkPeopleCampaignConflicts, checkCompaniesCampaignConflicts } from "@/lib/emailbison/push-to-emailbison";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

type Entity = "people" | "companies";

function isEntity(value: unknown): value is Entity {
  return value === "people" || value === "companies";
}

/** Pre-flight check for the "Add to Campaign" confirm step (the gap reported
 * live: 351 leads silently failed with no warning until the Push Activity
 * panel refreshed minutes later). Resolves the same candidate set the push
 * itself would use and reports how many already look attached to a
 * different campaign in this workspace, so the confirm dialog can warn and
 * offer "allow parallel sending" before the user hits Push. */
export async function GET(request: NextRequest) {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { searchParams } = request.nextUrl;
  const entity = searchParams.get("entity");
  const clientId = searchParams.get("clientId");
  const campaignId = searchParams.get("campaignId");

  if (!isEntity(entity)) {
    return Response.json({ error: 'entity must be "people" or "companies"' }, { status: 400 });
  }
  if (!clientId) {
    return Response.json({ error: "A clientId is required" }, { status: 400 });
  }
  if (!campaignId) {
    return Response.json({ error: "A campaignId is required" }, { status: 400 });
  }

  const client = await getClientById(clientId);
  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  const result =
    entity === "people"
      ? await checkPeopleCampaignConflicts(parsePersonFilters(searchParams), client, campaignId)
      : await checkCompaniesCampaignConflicts(parseCompanyFilters(searchParams), client, campaignId);

  return Response.json(result);
}
