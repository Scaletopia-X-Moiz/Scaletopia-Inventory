import type { NextRequest } from "next/server";
import { listPushHistory, type PushHistoryFilters } from "@/lib/data/push-history";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/** Paginated fetch backing the "Load more" button and Client/Platform
 * filters on /push-history. */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const offset = Number(params.get("offset") ?? "0");
  const from = Number.isFinite(offset) && offset >= 0 ? offset : 0;

  const clientId = params.get("clientId");
  const platform = params.get("platform");
  const filters: PushHistoryFilters = {};
  if (clientId) filters.clientId = clientId;
  if (platform) filters.platform = platform;

  try {
    const { rows, total } = await listPushHistory(filters, PAGE_SIZE, from);
    return Response.json({ rows, hasMore: from + rows.length < total });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch push history.";
    return Response.json({ error: message }, { status: 500 });
  }
}
