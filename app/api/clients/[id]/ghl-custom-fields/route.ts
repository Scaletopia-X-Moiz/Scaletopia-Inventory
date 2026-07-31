import type { NextRequest } from "next/server";
import { getClientById } from "@/lib/data/clients";
import { getGhlCustomFields } from "@/lib/ghl/custom-fields";
import { GhlApiError } from "@/lib/ghl/client";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** A client's GHL custom fields, for the push button's field-mapping step
 * (ticket #51) — getGhlCustomFields itself is server-only, so this route is
 * the seam that lets the browser-side mapping UI read it. */
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
  if (!client || !client.ghlApiKey || !client.ghlLocationId) {
    return Response.json({ error: "Client has no GHL credentials configured" }, { status: 404 });
  }

  try {
    const fields = await getGhlCustomFields({
      id: client.id,
      apiKey: client.ghlApiKey,
      locationId: client.ghlLocationId,
    });
    return Response.json({ fields });
  } catch (err) {
    const message = err instanceof GhlApiError || err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
