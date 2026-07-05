import "server-only";
import type { NextRequest } from "next/server";
import { preflightRecords } from "@/lib/import/push";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: {
    // BUG B: the client now sends one identity record per mapped row (each
    // carrying that row's domain/website/linkedin/email together) rather than
    // two flat `domains`/`linkedins` arrays. This lets preflight dedupe and
    // partition over the SAME unit (one record per row) that the real push
    // uses, so a row with both a domain and a linkedin is counted once, not
    // twice.
    records: Record<string, unknown>[];
    rowCount: number;
    targetTable: "companies" | "people";
  };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { records, rowCount, targetTable } = body;

  if (!Array.isArray(records) || typeof rowCount !== "number" || !targetTable) {
    return Response.json(
      { error: "records, rowCount, and targetTable are required" },
      { status: 400 }
    );
  }

  // `preflightRecords` normalizes domain/linkedin (deriving domain from
  // website_url when needed) and dedupes/partitions exactly like `pushRecords`,
  // so the records pass straight through untouched.
  if (records.length === 0) {
    return Response.json({
      inputCount: rowCount,
      dedupedCount: 0,
      insertCount: 0,
      updateCount: 0,
    });
  }

  try {
    const result = await preflightRecords(records, targetTable);
    // Override inputCount with the true row count from the client
    return Response.json({ ...result, inputCount: rowCount });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Preflight failed";
    return Response.json({ error: message }, { status: 500 });
  }
}
