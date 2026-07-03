import type { NextRequest } from "next/server";
import { pushRecords, type PushProgress, type PushResult } from "@/lib/import/push";
import { parseCSV, applyColumnMap } from "@/lib/import/csv";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { IMPORT_BUCKET } from "@/lib/import/storage";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const IMPORT_TOKEN = "scaletopia-import-2026";

type ImportMeta = {
  targetTable: "companies" | "people";
  sourceKey: string;
  tags: [string, string, string];
  columnMap: Record<string, string>;
};

function sseEvent(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

export async function POST(request: NextRequest) {
  const token = request.headers.get("X-Import-Token");
  if (token !== IMPORT_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  const contentType = request.headers.get("content-type") ?? "";

  let csvText: string;
  let meta: ImportMeta;
  // Set when the CSV came in via the Supabase Storage relay (large-file
  // path), so we know to clean up the temp object once we're done with it.
  let storagePath: string | null = null;

  if (contentType.includes("application/json")) {
    // Large-file path: the browser already uploaded the CSV directly to
    // Supabase Storage; we're just given the object path to fetch it from.
    let body: { path?: string; metadata?: string };
    try {
      body = await request.json();
    } catch {
      return new Response("Invalid JSON body", { status: 400 });
    }

    if (!body.path || !body.metadata) {
      return new Response("Missing path or metadata", { status: 400 });
    }

    try {
      meta = JSON.parse(body.metadata);
    } catch {
      return new Response("Invalid metadata JSON", { status: 400 });
    }

    storagePath = body.path;

    const { data, error } = await supabaseAdmin.storage
      .from(IMPORT_BUCKET)
      .download(storagePath);

    if (error || !data) {
      const message = error instanceof Error ? error.message : "unknown error";
      return new Response(`Failed to download uploaded file: ${message}`, { status: 400 });
    }

    csvText = await data.text();
  } else {
    // Small-file path: the CSV was posted directly in the request body.
    let formData: FormData;
    try {
      formData = await request.formData();
    } catch {
      return new Response("Invalid form data", { status: 400 });
    }

    const file = formData.get("file") as File | null;
    const metaRaw = formData.get("metadata") as string | null;

    if (!file || !metaRaw) {
      return new Response("Missing file or metadata", { status: 400 });
    }

    try {
      meta = JSON.parse(metaRaw);
    } catch {
      return new Response("Invalid metadata JSON", { status: 400 });
    }

    csvText = await file.text();
  }

  const { rows } = parseCSV(csvText);

  if (rows.length === 0) {
    return new Response("CSV has no data rows", { status: 400 });
  }

  const mappedRecords = applyColumnMap(rows, meta.columnMap);

  const stream = new ReadableStream({
    async start(controller) {
      try {
        const onProgress = (progress: PushProgress) => {
          controller.enqueue(sseEvent(progress));
        };

        const result: PushResult = await pushRecords(
          {
            records: mappedRecords,
            targetTable: meta.targetTable,
            sourceKey: meta.sourceKey,
            tags: meta.tags,
            columnMap: meta.columnMap,
          },
          onProgress
        );

        controller.enqueue(sseEvent({ phase: "done", result }));
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        controller.enqueue(sseEvent({ phase: "error", message }));
      } finally {
        if (storagePath) {
          try {
            await supabaseAdmin.storage.from(IMPORT_BUCKET).remove([storagePath]);
          } catch {
            // Best-effort cleanup; an orphaned temp object isn't fatal.
          }
        }
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
}
