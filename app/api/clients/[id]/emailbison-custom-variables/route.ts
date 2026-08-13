import type { NextRequest } from "next/server";
import { getClientById } from "@/lib/data/clients";
import { EmailBisonApiError, listCustomVariables } from "@/lib/emailbison/client";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** A client's EmailBison custom variables, for the Add-to-EmailBison button's
 * read-only reference list (issue #61) — listCustomVariables itself is
 * server-only, so this route is the seam that lets the browser-side panel
 * read it. Mirrors the GHL custom-fields route.
 *
 * Always fetches fresh from EmailBison rather than going through any
 * process-local cache: this panel exists so operators can check a variable
 * they just created (via ensureCustomVariablesExist, during a push) actually
 * landed in the workspace before reusing its name (issue #56) — a cache that
 * might not have observed that write would defeat the whole point. This is a
 * low-frequency, user-triggered fetch (opened once per push-dialog session)
 * and listCustomVariables is already a light paginated GET, so the cost of
 * always refetching is negligible next to the risk of showing stale data. */
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
    const variables = await listCustomVariables({
      apiKey: client.emailbisonApiKey,
      workspaceId: client.emailbisonWorkspaceId,
    });
    return Response.json({ variables });
  } catch (err) {
    const message = err instanceof EmailBisonApiError || err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
