import { after, type NextRequest } from "next/server";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";
import { getClientById } from "@/lib/data/clients";
import { createPushJob } from "@/lib/data/push-jobs";
import type { EmailBisonCustomVariableEntry, EmailBisonStandardFieldMapping } from "@/lib/emailbison/types";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

type Entity = "people" | "companies";
type Action = "workspace" | "campaign";

/** Header on the immediate worker kick, so a configured PUSH_WORKER_SECRET
 * still lets our own trigger through the worker route's optional gate. */
function workerKickHeaders(): Record<string, string> {
  const workerSecret = process.env.PUSH_WORKER_SECRET;
  return workerSecret ? { "x-worker-secret": workerSecret } : {};
}

function isEntity(value: unknown): value is Entity {
  return value === "people" || value === "companies";
}

function isAction(value: unknown): value is Action {
  return value === "workspace" || value === "campaign";
}

function isExistingLeadBehavior(value: unknown): value is "patch" | "put" {
  return value === "patch" || value === "put";
}

function isCustomVariableEntry(value: unknown): value is EmailBisonCustomVariableEntry {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.name !== "string" || typeof v.value !== "string") return false;
  return v.columnKey === undefined || typeof v.columnKey === "string";
}

/** Parses the manually-entered custom-variable rows (issue #52's panel) off
 * the request body. Malformed entries are dropped rather than rejected,
 * matching how the GHL route's field-mapping parsing degrades. */
function parseCustomVariables(value: unknown): EmailBisonCustomVariableEntry[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isCustomVariableEntry);
}

/** Any string is a valid per-field source now (a record/virtual/custom_data
 * column key, or the "skip" sentinel) — free-source mapping (rework of issue
 * #110/#108) dropped the fixed include/skip and 3-way companyName enums, so
 * this only needs to check shape, not enum membership. Legacy values
 * ("include", "brand_name", "company_name") are tolerated downstream by
 * buildEmailBisonLeadPayload's normalizeFieldSource, not rejected here. */
function isStandardFieldMapping(value: unknown): value is EmailBisonStandardFieldMapping {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.companyName === "string" &&
    typeof v.firstName === "string" &&
    typeof v.lastName === "string" &&
    typeof v.email === "string" &&
    typeof v.phone === "string" &&
    typeof v.title === "string" &&
    typeof v.website === "string"
  );
}

/** Parses the standard-field mapping off the request body. An absent or
 * malformed value is dropped to `undefined` so buildEmailBisonLeadPayload
 * falls back to today's default behavior, rather than rejecting the
 * request. */
function parseStandardFieldMapping(value: unknown): EmailBisonStandardFieldMapping | undefined {
  return isStandardFieldMapping(value) ? value : undefined;
}

export async function POST(request: NextRequest) {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { entity, action, clientId, campaignId, parallel } = body;
  // Whether to auto-launch (resume) the campaign once the worker finishes
  // attaching leads. Only meaningful for the campaign action, but stored as-is;
  // the worker applies it on the terminal tick when ≥1 lead attached.
  const launchOnComplete = typeof body.launchOnComplete === "boolean" ? body.launchOnComplete : undefined;

  if (!isEntity(entity)) {
    return Response.json({ error: 'entity must be "people" or "companies"' }, { status: 400 });
  }
  if (!isAction(action)) {
    return Response.json({ error: 'action must be "workspace" or "campaign"' }, { status: 400 });
  }
  if (typeof clientId !== "string" || clientId.trim() === "") {
    return Response.json({ error: "A clientId is required" }, { status: 400 });
  }
  if (action === "campaign" && (typeof campaignId !== "string" || campaignId.trim() === "")) {
    return Response.json({ error: "A campaignId is required for the campaign action" }, { status: 400 });
  }

  const existingLeadBehavior = isExistingLeadBehavior(body.existingLeadBehavior)
    ? body.existingLeadBehavior
    : undefined;
  const customVariables = parseCustomVariables(body.customVariables);
  const standardFieldMapping = parseStandardFieldMapping(body.standardFieldMapping);

  const client = await getClientById(clientId);
  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  // Filters ride in the query string (identical parsing to export/results/
  // push-to-clay/push-to-ghl); which parser applies depends on `entity`,
  // since People and Companies filters aren't interchangeable shapes.
  const personFilters = entity === "people" ? parsePersonFilters(request.nextUrl.searchParams) : null;
  const companyFilters = entity === "companies" ? parseCompanyFilters(request.nextUrl.searchParams) : null;

  // Background execution (issue #120): rather than run the push inline in an
  // SSE stream (which the ~300s serverless cap could kill mid-run), enqueue a
  // push_jobs row and return its id immediately. The worker resolves the
  // stored filter snapshot every tick and processes in resumable chunks; the
  // UI polls GET /api/push-jobs/[id] for progress.
  const platform =
    action === "campaign"
      ? "emailbison_campaign"
      : entity === "people"
        ? "emailbison_people"
        : "emailbison_companies";

  const niche = personFilters?.niche?.include ?? companyFilters?.niche?.include ?? [];
  const filters = (entity === "people" ? personFilters : companyFilters) ?? {};

  const job = await createPushJob({
    clientId: client.id,
    platform,
    entity,
    action,
    campaignId: action === "campaign" ? (campaignId as string) : null,
    niche,
    filters: filters as Record<string, unknown>,
    options: {
      existingLeadBehavior,
      customVariables,
      standardFieldMapping,
      parallel: typeof parallel === "boolean" ? parallel : undefined,
      launchOnComplete,
    },
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
      console.error(`[emailbison/push] worker kick failed (jobId=${job.id}): ${message}`);
    });
  });

  return Response.json({ jobId: job.id });
}
