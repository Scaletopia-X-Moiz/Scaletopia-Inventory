import type { NextRequest } from "next/server";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { runPeopleClayPush, isValidWebhookUrl, type ClayPushProgress } from "@/lib/clay/push-to-clay";
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

  // Filters ride in the query string (identical parsing to export/results);
  // the webhook target is supplied per-push in the JSON body.
  const filters = parsePersonFilters(request.nextUrl.searchParams);

  let webhookUrl: unknown;
  try {
    ({ webhookUrl } = await request.json());
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (!isValidWebhookUrl(webhookUrl)) {
    return Response.json(
      { error: "A valid https webhook URL is required" },
      { status: 400 }
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const result = await runPeopleClayPush(filters, webhookUrl, {
          onProgress: (p: ClayPushProgress) =>
            controller.enqueue(sseEvent({ type: "progress", ...p })),
        });
        await logActivity(
          "clay.push",
          {
            target: "people",
            totalMatched: result.total_matched,
            pushed: result.pushed,
            errors: result.errors,
          },
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
