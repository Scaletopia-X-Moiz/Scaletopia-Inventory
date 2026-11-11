import { supabaseAdmin } from "@/lib/supabase/admin";
import { syncClientsFromAirtable } from "@/lib/clients/location-sync";
import { logActivity } from "@/lib/activity/log";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Hourly Airtable -> `clients` sync (vercel.json cron), so a GHL sub-account
 * or EmailBison workspace added to Airtable's Locations table shows up in the
 * push pickers without anyone editing /clients. Only inserts rows and fills
 * empty credentials; see lib/clients/location-sync-plan.ts. The same sync runs
 * on demand from the "Sync from Airtable" button on /clients.
 *
 * Auth mirrors /api/internal/push-worker: genuine Vercel cron requests, or
 * `Authorization: Bearer $CRON_SECRET` when that secret is set. The run is
 * idempotent and only adds verified data, so a stray call is harmless. */
function authorized(request: Request): boolean {
  const ua = request.headers.get("user-agent") ?? "";
  if (request.headers.get("x-vercel-cron") || request.headers.get("x-vercel-cron-schedule") || ua.startsWith("vercel-cron")) {
    return true;
  }
  const cronSecret = process.env.CRON_SECRET;
  if (!cronSecret) return true;
  return request.headers.get("authorization") === `Bearer ${cronSecret}`;
}

export async function GET(request: Request): Promise<Response> {
  if (!authorized(request)) return Response.json({ error: "Unauthorized" }, { status: 401 });

  const airtableToken = process.env.AIRTABLE_TOKEN;
  if (!airtableToken) {
    return Response.json({ skipped: "AIRTABLE_TOKEN is not set" }, { status: 200 });
  }

  try {
    const { result } = await syncClientsFromAirtable({ supabase: supabaseAdmin, airtableToken });
    const inserted = result?.inserted.map((r) => r.name) ?? [];
    const filled = result?.filled.map((r) => r.name) ?? [];
    if (inserted.length || filled.length) {
      await logActivity("client.airtable_sync", { inserted, filled, trigger: "cron" });
    }
    return Response.json({ inserted, filled, needsAttention: result?.notes.length ?? 0 });
  } catch (err) {
    console.error("clients-sync failed:", err instanceof Error ? err.message : err);
    return Response.json({ error: "Sync failed" }, { status: 500 });
  }
}
