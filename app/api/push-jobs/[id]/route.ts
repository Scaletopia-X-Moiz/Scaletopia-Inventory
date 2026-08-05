import { getPushJob } from "@/lib/data/push-jobs";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** Polling endpoint for a single push job's live status (issue #120). The
 * push buttons poll this until the job reaches a terminal status; the richer
 * Push Activity panel (#122) will consume it too. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!(await getUser())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const job = await getPushJob(id);
  if (!job) {
    return Response.json({ error: "Push job not found" }, { status: 404 });
  }

  return Response.json(job);
}
