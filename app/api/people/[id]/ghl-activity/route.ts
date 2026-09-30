import { getPersonGhlMessages } from "@/lib/data/ghl-activity";
import { getUser } from "@/lib/auth/dal";

/** The message history the People table's last-activity drawer renders.
 *
 * Served from our own `ghl_messages`, not live from GHL — see
 * getPersonGhlMessages for why. Mirrors app/api/companies/[id]/people/route.ts,
 * the drawer precedent this feature copies, with an auth gate added because
 * message bodies are real lead correspondence. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!(await getUser())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }
  const { id } = await params;
  const messages = await getPersonGhlMessages(id);
  return Response.json({ messages });
}
