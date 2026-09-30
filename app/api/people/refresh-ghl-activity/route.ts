import { after, type NextRequest } from "next/server";
import { getClientById } from "@/lib/data/clients";
import { enqueueGhlActivitySync } from "@/lib/ghl/enqueue-activity-sync";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

/** Header on the immediate worker kick, so a configured PUSH_WORKER_SECRET
 * still lets our own trigger through the worker route's optional gate.
 * Identical to the push route's copy (app/api/people/push-to-ghl/route.ts). */
function workerKickHeaders(): Record<string, string> {
  const workerSecret = process.env.PUSH_WORKER_SECRET;
  return workerSecret ? { "x-worker-secret": workerSecret } : {};
}

/** The People table's "Refresh last activity" button: re-syncs GHL last
 * activity for every contact already pushed to `clientId`.
 *
 * Takes no filters, unlike the push route. The sync's working set is "every
 * contact this client has a platform_contact_id for" — a property of the
 * client, not of the view — and scoping it to the current filter would make
 * the refreshed set depend on which page the user happened to be looking at.
 *
 * `full: true` skips the incremental sweep and re-reads every pushed contact
 * directly. The default (false) sweeps first, which in steady state is a
 * couple of API calls instead of one per contact.
 *
 * Returns the job id immediately; progress is polled from
 * GET /api/push-jobs/[id], exactly like a push. */
export async function POST(request: NextRequest): Promise<Response> {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let clientId: unknown;
  let full: unknown;
  try {
    ({ clientId, full } = await request.json());
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (typeof clientId !== "string" || clientId.trim() === "") {
    return Response.json({ error: "A clientId is required" }, { status: 400 });
  }

  const client = await getClientById(clientId);
  if (!client) {
    return Response.json({ error: "Client not found" }, { status: 404 });
  }
  if (!client.ghlApiKey || !client.ghlLocationId) {
    return Response.json({ error: `${client.name} has no GHL credentials configured` }, { status: 400 });
  }

  const job = await enqueueGhlActivitySync({
    clientId: client.id,
    full: full === true,
    triggeredByUserId: user.id,
    triggeredByEmail: user.email,
  });

  // Kick the worker so the user doesn't wait for the next cron minute; the
  // Vercel Cron backstop covers a dropped kick.
  after(() => {
    fetch(new URL("/api/internal/push-worker", request.url), {
      method: "POST",
      headers: workerKickHeaders(),
    }).catch((err) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[refresh-ghl-activity] worker kick failed (jobId=${job.id}): ${message}`);
    });
  });

  return Response.json({ jobId: job.id });
}
