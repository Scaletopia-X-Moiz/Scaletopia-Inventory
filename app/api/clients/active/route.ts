import { listActiveClients } from "@/lib/data/clients";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** Active clients for client-picker UI (e.g. the GHL push button) — exposes
 * only what a picker needs, never the credential values themselves. */
export async function GET() {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const clients = await listActiveClients();
  return Response.json({
    clients: clients.map((c) => ({
      id: c.id,
      name: c.name,
      hasGhlCredentials: Boolean(c.ghlApiKey && c.ghlLocationId),
    })),
  });
}
