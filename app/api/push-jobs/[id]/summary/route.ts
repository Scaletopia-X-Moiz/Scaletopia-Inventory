import { getPushJobSummary } from "@/lib/data/push-jobs";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** Minimal push-job facts (client name, platform, timestamp) for the
 * "From push <client> · <timestamp>" deep-link filter chip (#123) — so the
 * People/Companies filter UI can label an active `?pushJobId=` filter instead
 * of showing a raw uuid. Auth-guarded like the other push-job endpoints; a
 * missing job is a 404 so the chip can fall back to a generic label. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  if (!(await getUser())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const summary = await getPushJobSummary(id);
  if (!summary) {
    return Response.json({ error: "Push job not found" }, { status: 404 });
  }

  return Response.json(summary);
}
