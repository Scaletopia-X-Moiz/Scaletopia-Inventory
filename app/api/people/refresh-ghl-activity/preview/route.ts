import type { NextRequest } from "next/server";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { parseActivityScope } from "@/lib/ghl/activity-scope";
import { planActivityRefresh } from "@/lib/ghl/refresh-activity-plan";
import { listClientOptions } from "@/lib/data/clients";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";
/** A read, but a heavy one: it resolves the same population the POST does
 * (up to MAX_FILTER_SCAN people, then their platform_pushes rows) and the
 * dialog calls it on open and on every narrowing change. Without this it
 * inherits the platform's 10s default and the dialog shows "failed to work
 * out what this would refresh" on exactly the large filters where knowing
 * the cost matters most. */
export const maxDuration = 300;

/** What a refresh would do, without doing it — so the confirm dialog states
 * the real population and the real API cost BEFORE the user commits, instead
 * of a filter count that the job never ran on.
 *
 * POST, unlike the push preview's GET, because the scope can carry up to
 * MAX_TARGETED_IDS person ids and 2,000 uuids is ~74 KB of URL. It is still a
 * read: it resolves the same plan the POST endpoint enqueues from (one
 * `planActivityRefresh` call, so the two cannot disagree) and writes nothing.
 *
 * Filters ride on the query string, as everywhere else in this feature. */
export async function POST(request: NextRequest): Promise<Response> {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ code: "invalid_body", error: "Invalid request body" }, { status: 400 });
  }
  const raw = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;

  const scope = parseActivityScope(raw.scope);
  if (!scope.ok) {
    return Response.json({ code: "empty_scope", error: scope.error }, { status: 400 });
  }

  const clientIds = Array.isArray(raw.clientIds)
    ? Array.from(new Set(raw.clientIds.filter((id): id is string => typeof id === "string" && id.trim() !== "")))
    : null;

  const planned = await planActivityRefresh({
    scope: scope.scope,
    filters: parsePersonFilters(request.nextUrl.searchParams),
    clientIds,
  });

  // An over-cap or "pick a sub-account" plan is the answer the dialog needs,
  // not an error it has to handle twice: it comes back 200 with `blocked` set
  // so the dialog can disable Confirm and show the reason, and the POST
  // endpoint refuses it again anyway if the user gets past this.
  if (!planned.ok) {
    // `mode` rides along even here: the dialog's wording depends on which
    // refresh the user is looking at, and a blocked one still has to be named
    // correctly ("every contact this sub-account pushed", not "the people your
    // filters match").
    return Response.json({
      blocked: planned.code,
      error: planned.error,
      mode: planned.code === "too_many_filtered" ? "filtered" : "all_pushed",
    });
  }

  const names = new Map((await listClientOptions()).map((c) => [c.id, c.name]));

  return Response.json({
    blocked: null,
    mode: planned.plan.mode,
    personCount: planned.plan.personCount,
    clientCount: planned.plan.clients.length,
    estimatedCalls: planned.plan.estimatedCalls,
    // Per sub-account, so the dialog can name where the work lands. The person
    // ids behind these counts are deliberately not serialized — the dialog has
    // no use for 25,000 uuids.
    //
    // Named from `listClientOptions`, which reads EVERY client row rather than
    // the active ones: a person pushed to a sub-account that has since been
    // deactivated is still refreshed and still costs calls, and resolving the
    // name against the active-clients picker printed a bare uuid for exactly
    // those.
    clients: planned.plan.clients.map((c) => ({
      clientId: c.clientId,
      name: names.get(c.clientId) ?? null,
      personCount: c.personCount,
      estimatedCalls: c.estimatedCalls,
    })),
  });
}
