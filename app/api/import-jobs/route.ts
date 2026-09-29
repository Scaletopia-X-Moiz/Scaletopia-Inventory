import { after, type NextRequest } from "next/server";
import { getUser } from "@/lib/auth/dal";
import { logActivity } from "@/lib/activity/log";
import { createImportJob, listImportJobs, type ImportJobStage } from "@/lib/data/import-jobs";

export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/** Header on the immediate worker kick, so a configured PUSH_WORKER_SECRET
 * still lets our own trigger through the worker route's optional gate. */
function workerKickHeaders(): Record<string, string> {
  const workerSecret = process.env.PUSH_WORKER_SECRET;
  return workerSecret ? { "x-worker-secret": workerSecret } : {};
}

function isTargetTable(value: unknown): value is ImportJobStage["targetTable"] {
  return value === "companies" || value === "people";
}

/** Validates the `stages` array: 1-2 entries, each with a known target table
 * and a string->string column map; two stages must be [companies, people]
 * (people's company_id lookup needs the companies committed first). Returns the
 * cleaned stages, or an error message. */
function parseStages(value: unknown): { stages: ImportJobStage[] } | { error: string } {
  if (!Array.isArray(value) || value.length < 1 || value.length > 2) {
    return { error: "stages must contain 1 or 2 entries" };
  }
  const stages: ImportJobStage[] = [];
  for (const raw of value) {
    const entry = raw as { targetTable?: unknown; columnMap?: unknown } | null;
    if (!entry || !isTargetTable(entry.targetTable)) {
      return { error: 'each stage needs a targetTable of "companies" or "people"' };
    }
    const columnMap = entry.columnMap;
    if (!columnMap || typeof columnMap !== "object" || Array.isArray(columnMap)) {
      return { error: "each stage needs a columnMap object" };
    }
    const cleaned: Record<string, string> = {};
    for (const [header, field] of Object.entries(columnMap as Record<string, unknown>)) {
      if (typeof field !== "string") return { error: "columnMap values must be strings" };
      cleaned[header] = field;
    }
    stages.push({ targetTable: entry.targetTable, columnMap: cleaned });
  }
  if (stages.length === 2 && (stages[0].targetTable !== "companies" || stages[1].targetTable !== "people")) {
    return { error: "a two-stage import must be [companies, people]" };
  }
  return { stages };
}

/** Enqueues an import (T22). The browser has already uploaded the CSV to the
 * csv-imports bucket via /api/import/storage-upload; this just records the job
 * and kicks the worker, then returns `{ jobId }` right away. */
export async function POST(request: NextRequest): Promise<Response> {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { path, fileName, rowCount, sourceKey, tags } = body;

  if (typeof path !== "string" || !path.startsWith("imports/")) {
    return Response.json({ error: 'path must start with "imports/"' }, { status: 400 });
  }
  if (typeof sourceKey !== "string" || sourceKey.trim() === "") {
    return Response.json({ error: "A sourceKey is required" }, { status: 400 });
  }
  if (!Array.isArray(tags) || tags.length !== 3 || !tags.every((t) => typeof t === "string")) {
    return Response.json({ error: "tags must be [client, niche, date]" }, { status: 400 });
  }

  const parsed = parseStages(body.stages);
  if ("error" in parsed) {
    return Response.json({ error: parsed.error }, { status: 400 });
  }

  const job = await createImportJob({
    sourceKey,
    tags: tags as string[],
    stages: parsed.stages,
    storagePath: path,
    fileName: typeof fileName === "string" ? fileName : null,
    rowCount: typeof rowCount === "number" && Number.isFinite(rowCount) ? rowCount : 0,
    triggeredByUserId: user.id,
    triggeredByEmail: user.email,
  });

  await logActivity(
    "import.enqueue",
    {
      jobId: job.id,
      sourceKey,
      tags,
      stages: parsed.stages.map((s) => s.targetTable),
      fileName: job.fileName,
      rowCount: job.rowCount,
    },
    user
  );

  // Kick the worker immediately so the user doesn't wait for the next cron
  // minute. Fire-and-forget after the response is sent; the Vercel Cron
  // backstop covers a dropped kick.
  after(() => {
    fetch(new URL("/api/internal/import-worker", request.url), {
      method: "POST",
      headers: workerKickHeaders(),
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[import-jobs] worker kick failed (jobId=${job.id}): ${message}`);
    });
  });

  return Response.json({ jobId: job.id });
}

/** Paginated import-job list backing the Import Queue view — its "Load more"
 * and the ~1.5s poll it runs while any job is queued/running. Never includes
 * failed records (fetched lazily from [id]?include=failed). */
export async function GET(request: NextRequest): Promise<Response> {
  if (!(await getUser())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const offset = Number(request.nextUrl.searchParams.get("offset") ?? "0");
  const from = Number.isFinite(offset) && offset >= 0 ? offset : 0;

  try {
    const { rows, total } = await listImportJobs(PAGE_SIZE, from);
    return Response.json({ rows, hasMore: from + rows.length < total });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch import jobs.";
    return Response.json({ error: message }, { status: 500 });
  }
}
