import type { NextRequest } from "next/server";
import { getClientById } from "@/lib/data/clients";
import { getEmailBisonCustomVariables } from "@/lib/emailbison/custom-variables";
import { EmailBisonApiError } from "@/lib/emailbison/client";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** A client's EmailBison custom variables, for the Add-to-EmailBison button's
 * read-only reference list (issue #61) — getEmailBisonCustomVariables itself
 * is server-only, so this route is the seam that lets the browser-side panel
 * read it. Mirrors the GHL custom-fields route. */
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
    const variables = await getEmailBisonCustomVariables({
      apiKey: client.emailbisonApiKey,
      workspaceId: client.emailbisonWorkspaceId,
    });
    return Response.json({ variables });
  } catch (err) {
    const message = err instanceof EmailBisonApiError || err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
