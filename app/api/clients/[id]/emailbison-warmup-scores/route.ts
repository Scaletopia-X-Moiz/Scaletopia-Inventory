import type { NextRequest } from "next/server";
import { getClientById } from "@/lib/data/clients";
import { EmailBisonApiError, listAllWarmupSenderEmails } from "@/lib/emailbison/client";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** A client's live EmailBison warmup stats, lazy-loaded by the sender-email
 * picker (components/emailbison/sender-email-picker.tsx) after the base
 * sender-email list has already rendered — the warmup-stats endpoint is a
 * separate, slower call, so the picker shows connection/warmup-on status
 * immediately and fills in warmup scores once this resolves. Mirrors the
 * emailbison-sender-emails route. */
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
    const warmupStats = await listAllWarmupSenderEmails({
      apiKey: client.emailbisonApiKey,
      workspaceId: client.emailbisonWorkspaceId,
    });
    return Response.json({ warmupStats });
  } catch (err) {
    const message = err instanceof EmailBisonApiError || err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
