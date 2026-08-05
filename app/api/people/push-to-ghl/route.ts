import { after, type NextRequest } from "next/server";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { getClientById } from "@/lib/data/clients";
import { createPushJob } from "@/lib/data/push-jobs";
import type { GhlFieldMapping, GhlStandardFieldMapping } from "@/lib/ghl/types";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** Header on the immediate worker kick, so a configured PUSH_WORKER_SECRET
 * still lets our own trigger through the worker route's optional gate. */
function workerKickHeaders(): Record<string, string> {
  const workerSecret = process.env.PUSH_WORKER_SECRET;
  return workerSecret ? { "x-worker-secret": workerSecret } : {};
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

function isStandardFieldMapping(value: unknown): value is GhlStandardFieldMapping {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  const isIncludeSkip = (v: unknown) => v === "include" || v === "skip";
  return (
    (m.companyName === "brand_name" || m.companyName === "company_name" || m.companyName === "skip") &&
    isIncludeSkip(m.firstName) &&
    isIncludeSkip(m.lastName) &&
    isIncludeSkip(m.email) &&
    isIncludeSkip(m.phone) &&
    isIncludeSkip(m.city) &&
    isIncludeSkip(m.country)
  );
}

/** Parses the standard (non-custom) field mapping (ticket #109) off the
 * request body. A malformed/missing mapping is dropped (returns undefined)
 * rather than rejected, matching parseFieldMapping's degrade-gracefully
 * convention — the orchestrator treats undefined as "no mapping" and keeps
 * today's always-include, prefer-brand-name behavior. */
function parseStandardFieldMapping(value: unknown): GhlStandardFieldMapping | undefined {
  return isStandardFieldMapping(value) ? value : undefined;
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
  let standardFieldMappingRaw: unknown;
  let customTagSuffixRaw: unknown;
  try {
    ({
      clientId,
      fieldMapping: fieldMappingRaw,
      standardFieldMapping: standardFieldMappingRaw,
      customTagSuffix: customTagSuffixRaw,
    } = await request.json());
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (typeof clientId !== "string" || clientId.trim() === "") {
    return Response.json({ error: "A clientId is required" }, { status: 400 });
  }

  const fieldMapping = parseFieldMapping(fieldMappingRaw);
  const standardFieldMapping = parseStandardFieldMapping(standardFieldMappingRaw);
  const customTagSuffix = typeof customTagSuffixRaw === "string" ? customTagSuffixRaw : undefined;

  const client = await getClientById(clientId);
  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  // Background execution (issue #120): enqueue a push_jobs row and return its
  // id immediately rather than running the push inline (the ~300s serverless
  // cap could otherwise kill a large run mid-stream). The worker resolves the
  // stored filter snapshot every tick and processes in resumable chunks; the
  // UI polls GET /api/push-jobs/[id] for progress.
  const niche = filters.niche?.include ?? [];

  const job = await createPushJob({
    clientId: client.id,
    platform: "ghl",
    entity: "people",
    action: null,
    campaignId: null,
    niche,
    filters: filters as Record<string, unknown>,
    options: { fieldMapping, standardFieldMapping, customTagSuffix },
    triggeredByUserId: user.id,
    triggeredByEmail: user.email,
  });

  // Kick the worker immediately so the user doesn't wait for the next cron
  // minute. Fire-and-forget after the response is sent; the Vercel Cron
  // backstop covers a dropped kick.
  after(() => {
    fetch(new URL("/api/internal/push-worker", request.url), {
      method: "POST",
      headers: workerKickHeaders(),
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[push-to-ghl] worker kick failed (jobId=${job.id}): ${message}`);
    });
  });

  return Response.json({ jobId: job.id });
}
