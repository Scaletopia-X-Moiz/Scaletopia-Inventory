import type { NextRequest } from "next/server";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { getClientById } from "@/lib/data/clients";
import { runPeopleGhlPush, type GhlPushProgress } from "@/lib/ghl/push-to-ghl";
import type { GhlFieldMapping } from "@/lib/ghl/types";
import { getUser } from "@/lib/auth/dal";
import { logActivity } from "@/lib/activity/log";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

function sseEvent(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

function isFieldMapping(value: unknown): value is GhlFieldMapping {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m.virtualColumnKey === "string" && typeof m.ghlFieldId === "string";
}

/** Parses the mapping step's chosen virtual-column → GHL-field pairs
 * (ticket #51) off the request body. Malformed entries are dropped rather
 * than rejected, matching how virtual-column filters degrade elsewhere in
 * this app rather than erroring the whole push over one bad entry. */
function parseFieldMapping(value: unknown): GhlFieldMapping[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isFieldMapping);
}

export async function POST(request: NextRequest) {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Filters ride in the query string (identical parsing to export/results/push-to-clay);
  // the target client is supplied per-push in the JSON body.
  const filters = parsePersonFilters(request.nextUrl.searchParams);

  let clientId: unknown;
  let fieldMappingRaw: unknown;
  try {
    ({ clientId, fieldMapping: fieldMappingRaw } = await request.json());
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (typeof clientId !== "string" || clientId.trim() === "") {
    return Response.json({ error: "A clientId is required" }, { status: 400 });
  }

  const fieldMapping = parseFieldMapping(fieldMappingRaw);

  const client = await getClientById(clientId);
  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const lastProgress: { current: GhlPushProgress | null } = { current: null };
      try {
        const result = await runPeopleGhlPush(filters, client, {
          fieldMapping,
          onProgress: (p: GhlPushProgress) => {
            lastProgress.current = p;
            controller.enqueue(sseEvent({ type: "progress", ...p }));
          },
        });
        await logActivity(
          "ghl.push",
          {
            target: "people",
            clientId: client.id,
            totalMatched: result.total_matched,
            eligible: result.eligible,
            skipped: result.skipped,
            pushed: result.pushed,
            created: result.created,
            tagAppended: result.tagAppended,
            errors: result.errors,
          },
          user
        );
        controller.enqueue(sseEvent({ type: "done", result }));
      } catch (err) {
        const message = (err as Error).message;
        await logActivity(
          "ghl.push",
          {
            target: "people",
            clientId: client.id,
            done: lastProgress.current?.done ?? 0,
            total: lastProgress.current?.total ?? 0,
            pushed: lastProgress.current?.pushed ?? 0,
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
