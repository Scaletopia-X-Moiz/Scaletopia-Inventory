import type { NextRequest } from "next/server";
import { getImportJob } from "@/lib/data/import-jobs";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** Single import job. `failed_records` (the current stage's, capped list) is an
 * uncapped-in-spirit jsonb, so it is only returned on request with
 * `?include=failed` — that's what the queue card's "Download failed records"
 * lazily fetches. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }): Promise<Response> {
  if (!(await getUser())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;
  const job = await getImportJob(id);
  if (!job) {
    return Response.json({ error: "Import job not found" }, { status: 404 });
  }

  const { failedRecords, ...summary } = job;
  if (request.nextUrl.searchParams.get("include") === "failed") {
    return Response.json({ ...summary, failed_records: failedRecords });
  }
  return Response.json(summary);
}
