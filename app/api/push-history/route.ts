import type { NextRequest } from "next/server";
import { listPushHistory } from "@/lib/data/push-history";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/** Paginated fetch backing the "Load more" button on /push-history. */
export async function GET(request: NextRequest) {
  const offset = Number(request.nextUrl.searchParams.get("offset") ?? "0");
  const from = Number.isFinite(offset) && offset >= 0 ? offset : 0;

  try {
    const { rows, total } = await listPushHistory({}, PAGE_SIZE, from);
    return Response.json({ rows, hasMore: from + rows.length < total });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch push history.";
    return Response.json({ error: message }, { status: 500 });
  }
}
