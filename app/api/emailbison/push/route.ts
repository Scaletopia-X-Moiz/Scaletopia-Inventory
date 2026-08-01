import type { NextRequest } from "next/server";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";
import { getClientById } from "@/lib/data/clients";
import {
  runPeopleAddToEmailBison,
  runCompaniesAddToEmailBison,
  runPeopleAddToCampaign,
  runCompaniesAddToCampaign,
  type EmailBisonPushProgress,
  type EmailBisonCampaignPushProgress,
  type RunEmailBisonPushDeps,
  type RunEmailBisonCampaignPushDeps,
} from "@/lib/emailbison/push-to-emailbison";
import type { EmailBisonCustomVariableEntry } from "@/lib/emailbison/types";
import { getUser } from "@/lib/auth/dal";
import { logActivity } from "@/lib/activity/log";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type Entity = "people" | "companies";
type Action = "workspace" | "campaign";

function sseEvent(data: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(data)}\n\n`);
}

/** Per ADR 0003: Add to Campaign attaches asynchronously on EmailBison's
 * side (up to ~5 minutes to sync), so its summary must say the leads were
 * queued rather than implying immediate campaign membership — unlike Add to
 * EmailBison, whose created/updated/failed counts are immediate. This note
 * carries that distinction on the wire so the caller doesn't have to
 * hard-code copy per action. */
function summaryNote(action: Action): string {
  return action === "workspace"
    ? "Leads were created or updated in the EmailBison workspace immediately."
    : "Leads were queued for campaign attachment — EmailBison syncs this asynchronously, up to ~5 minutes.";
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

  const client = await getClientById(clientId);
  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }

  // Filters ride in the query string (identical parsing to export/results/
  // push-to-clay/push-to-ghl); which parser applies depends on `entity`,
  // since People and Companies filters aren't interchangeable shapes.
  const personFilters = entity === "people" ? parsePersonFilters(request.nextUrl.searchParams) : null;
  const companyFilters = entity === "companies" ? parseCompanyFilters(request.nextUrl.searchParams) : null;

  const stream = new ReadableStream({
    async start(controller) {
      type Progress = EmailBisonPushProgress | EmailBisonCampaignPushProgress;
      const lastProgress: { current: Progress | null } = { current: null };
      const onProgress = <P extends Progress>(p: P) => {
        lastProgress.current = p;
        controller.enqueue(sseEvent({ type: "progress", ...p }));
      };

      try {
        let result;
        if (action === "workspace") {
          const deps: RunEmailBisonPushDeps = { existingLeadBehavior, customVariables, onProgress };
          result =
            entity === "people"
              ? await runPeopleAddToEmailBison(personFilters!, client, deps)
              : await runCompaniesAddToEmailBison(companyFilters!, client, deps);
        } else {
          const deps: RunEmailBisonCampaignPushDeps = {
            existingLeadBehavior,
            customVariables,
            parallel: typeof parallel === "boolean" ? parallel : undefined,
            onProgress,
          };
          result =
            entity === "people"
              ? await runPeopleAddToCampaign(personFilters!, client, campaignId as string, deps)
              : await runCompaniesAddToCampaign(companyFilters!, client, campaignId as string, deps);
        }

        await logActivity(
          "emailbison.push",
          {
            target: entity,
            action,
            clientId: client.id,
            ...result,
          },
          user
        );
        controller.enqueue(sseEvent({ type: "done", action, result, note: summaryNote(action) }));
      } catch (err) {
        const message = (err as Error).message;
        await logActivity(
          "emailbison.push",
          {
            target: entity,
            action,
            clientId: client.id,
            done: lastProgress.current?.done ?? 0,
            total: lastProgress.current?.total ?? 0,
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
