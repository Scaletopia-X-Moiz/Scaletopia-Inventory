import type { NextRequest } from "next/server";
import { getClientById } from "@/lib/data/clients";
import { EmailBisonApiError, listSenderEmails } from "@/lib/emailbison/client";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** A client's live EmailBison sender-email list, for the create-campaign
 * form's sender-emails multi-select (issue #94/#98) — listSenderEmails
 * itself is server-only, so this route is the seam that lets the
 * browser-side form read it. Mirrors the emailbison-campaigns route
 * (issue #63). */
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
    const { senderEmails } = await listSenderEmails({
      apiKey: client.emailbisonApiKey,
      workspaceId: client.emailbisonWorkspaceId,
    });
    return Response.json({ senderEmails });
  } catch (err) {
    const message = err instanceof EmailBisonApiError || err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
