import { randomUUID } from "node:crypto";
import { after, type NextRequest } from "next/server";
import { getClientById } from "@/lib/data/clients";
import { clearActivityQueueForJob, enqueueActivityContacts } from "@/lib/data/ghl-activity";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { enqueueGhlActivitySync } from "@/lib/ghl/enqueue-activity-sync";
import { parseActivityScope, type ActivityScope } from "@/lib/ghl/activity-scope";
import { planActivityRefresh, type RefreshPlanClient } from "@/lib/ghl/refresh-activity-plan";
import { errorMessage } from "@/lib/errors";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";
/** Resolving a filter, writing up to MAX_FILTERED_PEOPLE queue rows (chunked
 * at 500) and inserting one job per sub-account is well past the platform's
 * 10s default, and being killed halfway is the case that leaves orphaned
 * rows. Matches the other bulk write routes (push-to-clay, reverify). */
export const maxDuration = 300;

/** Header on the immediate worker kick, so a configured PUSH_WORKER_SECRET
 * still lets our own trigger through the worker route's optional gate.
 * Identical to the push route's copy (app/api/people/push-to-ghl/route.ts). */
function workerKickHeaders(): Record<string, string> {
  const workerSecret = process.env.PUSH_WORKER_SECRET;
  return workerSecret ? { "x-worker-secret": workerSecret } : {};
}

/** Error codes the UI branches on. The human-readable `error` rides alongside
 * and is what gets shown; the code is what gets switched on, so rewording a
 * message never breaks the frontend. */
type RefreshErrorCode = "invalid_body" | "empty_scope" | "too_many_ids" | "too_many_filtered";

function badRequest(code: RefreshErrorCode, error: string): Response {
  return Response.json({ code, error }, { status: 400 });
}

interface RefreshRequest {
  scope: ActivityScope;
  /** Narrowing, not an assertion — see `resolveClientIds`. */
  clientIds: string[] | null;
  full: boolean;
}

/** Parses both the current body and the legacy one.
 *
 * Backwards compatibility is not optional here: there is a live button sending
 * `{ clientId, full }`, and that shape maps to "this one sub-account, whatever
 * its filter snapshot resolves to" — exactly the behaviour this endpoint had
 * before it learned to fan out. */
function parseBody(body: unknown): RefreshRequest | { code: RefreshErrorCode; error: string } {
  if (typeof body !== "object" || body === null) {
    return { code: "invalid_body", error: "Invalid request body" };
  }
  const raw = body as Record<string, unknown>;

  const scope = parseActivityScope(raw.scope);
  if (!scope.ok) {
    // "Over the cap" is a different kind of wrong from "malformed": the caller
    // has a valid selection and a documented alternative (refresh by filter),
    // and the UI wants to say so rather than show a parse error.
    const code: RefreshErrorCode = scope.error.startsWith("Too many") ? "too_many_ids" : "empty_scope";
    return { code, error: scope.error };
  }

  let clientIds: string[] | null = null;
  if (Array.isArray(raw.clientIds)) {
    clientIds = Array.from(
      new Set(raw.clientIds.filter((id): id is string => typeof id === "string" && id.trim() !== ""))
    );
  } else if (typeof raw.clientId === "string" && raw.clientId.trim() !== "") {
    // Legacy body.
    clientIds = [raw.clientId];
  }

  return { scope: scope.scope, clientIds, full: raw.full === true };
}

/** Queues a filter-scoped job: the work list goes into the queue FIRST, under
 * a job id chosen here, and the job row is created after.
 *
 * That order is the whole point. The queue is already the durable, resumable
 * work list, so a bounded id set belongs in it rather than in
 * `push_jobs.options`, which is rewritten on every progress tick. But a job
 * row is claimable the moment it exists, and a pre-queued job does not resolve
 * its own work — a worker that claimed it between the insert and the queue
 * write would find an empty partition and report a no-op success. Writing the
 * rows first makes that window impossible.
 *
 * If the job row then fails to insert, the rows are dropped: nothing will ever
 * claim that partition, so they would leak forever. */
async function enqueueFilteredJob(
  target: RefreshPlanClient,
  ghlContactIds: string[],
  clientId: string,
  full: boolean,
  user: { id: string; email: string | null }
) {
  const jobId = randomUUID();
  try {
    // INSIDE the try, not before it. `enqueueActivityContacts` chunks at 500
    // and can fail halfway — a pool timeout is a live condition on this
    // project — and a half-written partition with no job row to claim it is
    // up to MAX_FILTERED_PEOPLE rows that nothing will ever delete. Cleanup
    // has to cover the queue write itself, not just the job insert.
    await enqueueActivityContacts(
      clientId,
      jobId,
      // No swept date, so `canSkipContact` always fetches — which is what a user
      // who asked for these specific people wants, and why `full` makes no
      // difference to a filtered refresh.
      ghlContactIds.map((ghlContactId) => ({ ghlContactId, lastMessageDate: null }))
    );
    return await enqueueGhlActivitySync({
      id: jobId,
      clientId,
      full,
      scope: { kind: "queued", personCount: target.personCount },
      triggeredByUserId: user.id,
      triggeredByEmail: user.email,
    });
  } catch (err) {
    // `.catch` rather than a bare await: the original failure is the one the
    // caller has to see, and a cleanup that throws on top of it would replace
    // "could not queue this sub-account" with a secondary error about rows
    // the user never knew existed. The leak is logged instead.
    await clearActivityQueueForJob(clientId, jobId).catch((cleanupErr) => {
      console.error(
        `[refresh-ghl-activity] orphaned queue rows for job ${jobId}: ${errorMessage(cleanupErr)}`
      );
    });
    throw err;
  }
}

/** The People table's "Refresh last activity" button.
 *
 * Fans out to ONE job per sub-account (Decision 1), never one job looping
 * clients: `push_jobs.client_id` is NOT NULL and `claim_next_runnable_job`
 * serializes on it (and, since the multi-sub-account work, on the client's GHL
 * location), which is the only thing preventing a sync and a push from
 * fighting over one location's burst budget. A job spanning clients would run
 * outside that guard entirely.
 *
 * `full: true` skips the incremental sweep and re-reads every pushed contact
 * directly; a `kind: "ids"` scope skips the sweep too, for a different reason
 * (Decision 3 — the caller has already done the discovery the sweep exists to
 * do), and so does a filter scope, whose population this endpoint resolves
 * before it queues anything.
 *
 * Returns the job ids immediately; progress is polled from the existing Push
 * Activity panel, which already merges a job LIST by id and therefore renders
 * N jobs today with no changes (Decision 7). */
export async function POST(request: NextRequest): Promise<Response> {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("invalid_body", "Invalid request body");
  }

  const parsed = parseBody(body);
  if ("code" in parsed) return badRequest(parsed.code, parsed.error);

  // Filters ride on the URL exactly as the push route reads them, and are
  // resolved HERE, once, rather than per tick by the sync. The sync cannot
  // re-resolve them honestly: `platform_pushes` is one of the filter's own
  // inputs and the sync writes to it as it runs, and `within_days`
  // re-evaluates against now() — so the population would drift under a
  // running job. Resolving once makes the number in the response the number
  // the jobs run on, at the cost of a snapshot that can go stale between
  // enqueue and drain. That is the trade a push job already makes.
  const filters = parsePersonFilters(request.nextUrl.searchParams);
  const planned = await planActivityRefresh({
    scope: parsed.scope,
    filters,
    clientIds: parsed.clientIds,
  });
  if (!planned.ok) return badRequest(planned.code, planned.error);
  const plan = planned.plan;

  // Zero sub-accounts is an OUTCOME, not a failure: the user selected rows
  // that have never been pushed to GHL (or narrowed to a sub-account they
  // were never pushed to). Saying so plainly beats a 400 the UI has to
  // translate.
  if (plan.clients.length === 0) {
    return Response.json({
      jobIds: [],
      clientCount: 0,
      personCount: 0,
      estimatedCalls: 0,
      mode: plan.mode,
      skippedClients: [],
      message:
        plan.mode === "all_pushed"
          ? "No matching GHL sub-account."
          : "None of those people have been pushed to a GHL sub-account, so there is nothing to refresh.",
    });
  }

  const jobIds: string[] = [];
  const skippedClients: { clientId: string; name: string | null; reason: string }[] = [];
  const enqueued: RefreshPlanClient[] = [];

  for (const target of plan.clients) {
    const client = await getClientById(target.clientId);
    if (!client) {
      skippedClients.push({ clientId: target.clientId, name: null, reason: "Client not found" });
      continue;
    }
    // One sub-account missing credentials must not sink the other four. The
    // skip is REPORTED rather than swallowed — silently dropping a sub-account
    // from a multi-sub-account refresh is exactly how someone comes to trust a
    // "refreshed" column that was never refreshed.
    if (!client.ghlApiKey || !client.ghlLocationId) {
      skippedClients.push({
        clientId: target.clientId,
        name: client.name,
        reason: `${client.name} has no GHL credentials configured`,
      });
      continue;
    }

    try {
      const job = target.ghlContactIds
        ? await enqueueFilteredJob(target, target.ghlContactIds, client.id, parsed.full, user)
        : await enqueueGhlActivitySync({
            clientId: client.id,
            full: parsed.full,
            scope: parsed.scope,
            triggeredByUserId: user.id,
            triggeredByEmail: user.email,
          });
      jobIds.push(job.id);
      enqueued.push(target);
    } catch (err) {
      skippedClients.push({ clientId: target.clientId, name: client.name, reason: errorMessage(err) });
    }
  }

  // Kick the worker once, not once per job: it drains whatever is runnable and
  // self-chains, and N simultaneous kicks would just race each other for the
  // same claim. The Vercel Cron backstop covers a dropped kick.
  if (jobIds.length > 0) {
    after(() => {
      fetch(new URL("/api/internal/push-worker", request.url), {
        method: "POST",
        headers: workerKickHeaders(),
      }).catch((err) => {
        console.error(`[refresh-ghl-activity] worker kick failed (jobIds=${jobIds.join(",")}): ${errorMessage(err)}`);
      });
    });
  }

  // Reported over the sub-accounts that actually got a job, not over the plan:
  // a skipped sub-account's people are not being refreshed and must not be
  // counted as if they were.
  const reached = new Set<string>();
  for (const target of enqueued) for (const id of target.personIds) reached.add(id);

  return Response.json({
    jobIds,
    clientCount: jobIds.length,
    // The UI words the count differently per mode: an `all_pushed` count is a
    // sum over sub-accounts, not distinct people.
    mode: plan.mode,
    personCount:
      plan.mode === "all_pushed" ? enqueued.reduce((sum, t) => sum + t.personCount, 0) : reached.size,
    estimatedCalls: enqueued.reduce((sum, t) => sum + t.estimatedCalls, 0),
    skippedClients,
  });
}
