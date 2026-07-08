import type { NextRequest } from "next/server";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";
import { runCompaniesReverify, type ReverifyProgress } from "@/lib/verify/reverify-phone";
import { getUser } from "@/lib/auth/dal";
import { logActivity } from "@/lib/activity/log";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function sseEvent(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: NextRequest) {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Filters ride in the query string, identical to export/results/push-to-clay,
  // so the verified set equals the on-screen filtered view.
  const filters = parseCompanyFilters(request.nextUrl.searchParams);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const result = await runCompaniesReverify(filters, {
          onProgress: (p: ReverifyProgress) =>
            controller.enqueue(sseEvent({ type: "progress", ...p })),
        });
        await logActivity(
          "verify.reverify",
          { target: "companies", kind: "phone", totalMatched: result.total_matched, verified: result.verified, errors: result.errors },
          user
        );
        controller.enqueue(sseEvent({ type: "done", result }));
      } catch (err) {
        controller.enqueue(sseEvent({ type: "error", message: (err as Error).message }));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
