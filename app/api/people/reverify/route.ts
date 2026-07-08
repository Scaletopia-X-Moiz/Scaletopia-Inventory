import type { NextRequest } from "next/server";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { runPeopleReverify, type ReverifyProgress } from "@/lib/verify/reverify";
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
  const filters = parsePersonFilters(request.nextUrl.searchParams);

  const stream = new ReadableStream({
    async start(controller) {
      const lastProgress: { current: ReverifyProgress | null } = { current: null };
      try {
        const result = await runPeopleReverify(filters, {
          onProgress: (p: ReverifyProgress) => {
            lastProgress.current = p;
            controller.enqueue(sseEvent({ type: "progress", ...p }));
          },
        });
        await logActivity(
          "verify.reverify",
          { target: "people", kind: "email", totalMatched: result.total_matched, verified: result.verified, errors: result.errors },
          user
        );
        controller.enqueue(sseEvent({ type: "done", result }));
      } catch (err) {
        const message = (err as Error).message;
        await logActivity(
          "verify.reverify",
          {
            target: "people",
            kind: "email",
            done: lastProgress.current?.done ?? 0,
            total: lastProgress.current?.total ?? 0,
            verified: lastProgress.current?.verified ?? 0,
            errors: lastProgress.current?.errors ?? 0,
            error: message,
            failed: true,
          },
          user
        );
        controller.enqueue(sseEvent({ type: "error", message }));
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
