import type { NextRequest } from "next/server";
import { getUser } from "@/lib/auth/dal";
import { listPushJobs, type PushJobFilters, type PushJobStatus } from "@/lib/data/push-jobs";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

const VALID_STATUSES = new Set<PushJobStatus>([
  "queued",
  "running",
  "succeeded",
  "failed",
  "partial",
  "canceled",
]);

/** Paginated push-job list backing the Push Activity panel (#122) — its
 * "Load more" button, its Client/Platform filters, and the ~1.5s poll it runs
 * while any job is queued/running. Auth-guarded like the single-job endpoint;
 * jobs carry who-triggered/credentials-adjacent context, so it's not public. */
export async function GET(request: NextRequest): Promise<Response> {
  if (!(await getUser())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const params = request.nextUrl.searchParams;
  const offset = Number(params.get("offset") ?? "0");
  const from = Number.isFinite(offset) && offset >= 0 ? offset : 0;

  const filters: PushJobFilters = {};
  const clientId = params.get("clientId");
  const platform = params.get("platform");
  const status = params.get("status");
  if (clientId) filters.clientId = clientId;
  if (platform) filters.platform = platform;
  // Only pass a status the DB actually recognizes — an arbitrary `?status=foo`
  // is dropped rather than cast straight into the query filter.
  if (status && VALID_STATUSES.has(status as PushJobStatus)) filters.status = status as PushJobStatus;

  try {
    const { rows, total } = await listPushJobs(filters, PAGE_SIZE, from);
    return Response.json({ rows, hasMore: from + rows.length < total });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch push jobs.";
    return Response.json({ error: message }, { status: 500 });
  }
}
