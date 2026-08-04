import type { NextRequest } from "next/server";
import { getClientById } from "@/lib/data/clients";
import {
  getEmailBisonCampaigns,
  createEmailBisonCampaign,
  type CreateEmailBisonCampaignInput,
} from "@/lib/emailbison/campaigns";
import { EmailBisonApiError } from "@/lib/emailbison/client";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** A client's live EmailBison campaign list, for the Add-to-Campaign
 * button's campaign picker (issue #63) — getEmailBisonCampaigns itself is
 * server-only, so this route is the seam that lets the browser-side panel
 * read it. Mirrors the emailbison-custom-variables route (issue #61). */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const client = await getClientById(id);
  if (!client || !client.emailbisonApiKey || !client.emailbisonWorkspaceId) {
    return Response.json({ error: "Client has no EmailBison credentials configured" }, { status: 404 });
  }

  try {
    const campaigns = await getEmailBisonCampaigns({
      id: client.id,
      apiKey: client.emailbisonApiKey,
      workspaceId: client.emailbisonWorkspaceId,
    });
    return Response.json({ campaigns });
  } catch (err) {
    const message = err instanceof EmailBisonApiError || err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}

/** Creates a new EmailBison campaign from the Add-to-Campaign wizard (issue
 * #94/#99), delegating the multi-call sequence to createEmailBisonCampaign
 * (issue #97). Mirrors GET's auth/credentials-lookup pattern exactly. */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const client = await getClientById(id);
  if (!client || !client.emailbisonApiKey || !client.emailbisonWorkspaceId) {
    return Response.json({ error: "Client has no EmailBison credentials configured" }, { status: 404 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { name, senderEmailIds, schedule, sequenceSteps, launch } = body;

  try {
    const campaign = await createEmailBisonCampaign(
      {
        id: client.id,
        apiKey: client.emailbisonApiKey,
        workspaceId: client.emailbisonWorkspaceId,
      },
      {
        name: name as string,
        senderEmailIds: senderEmailIds as string[],
        schedule: schedule as CreateEmailBisonCampaignInput["schedule"],
        steps: sequenceSteps as CreateEmailBisonCampaignInput["steps"],
        launch: launch as boolean,
      }
    );
    return Response.json({ campaign });
  } catch (err) {
    const message = err instanceof EmailBisonApiError || err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
