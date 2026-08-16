import { supabaseAdmin } from "@/lib/supabase/admin";
import { invalidatePeopleListCache } from "@/lib/data/people";
import { invalidateCompaniesListCache } from "@/lib/data/companies";
import { mapCertainty, verifyWebhookSignature, type RawItem } from "@/lib/icypeas/verify";

export const dynamic = "force-dynamic";

/** Path Icypeas is configured to call — must match whatever's registered
 * as the per-search webhookUrl (lib/verify/reverify.ts builds that URL from
 * the same NEXT_PUBLIC_SITE_URL/ICYPEAS_WEBHOOK_URL base + this path). Used
 * as the "endpoint path" half of the HMAC signature payload (research doc
 * §2b). */
const WEBHOOK_PATH = "/api/internal/icypeas-webhook";

/** Envelope Icypeas POSTs to a webhook: `{ signature, timestamp, data }`
 * where `data` is the same result-item shape documented in verify.ts'
 * RawItem (research doc §3b/§7 — "the webhook delivers the item directly",
 * i.e. `data` is NOT wrapped in another `item`/`items` envelope the way the
 * poll route's response is). */
interface WebhookBody {
  signature?: string;
  timestamp?: string;
  data?: RawItem;
}

type Table = "people" | "companies";

/** externalId is `${table}:${id}`, encoded by reverify.ts on submit. Kept as
 * a pure, easily-testable parse so the route handler stays thin. */
export function parseExternalId(externalId: string | undefined | null): { table: Table; id: string } | null {
  if (!externalId) return null;
  const sep = externalId.indexOf(":");
  if (sep <= 0) return null;
  const table = externalId.slice(0, sep);
  const id = externalId.slice(sep + 1);
  if ((table !== "people" && table !== "companies") || !id) return null;
  return { table, id };
}

export async function POST(request: Request): Promise<Response> {
  let body: WebhookBody;
  try {
    body = (await request.json()) as WebhookBody;
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // Signature verification is optional per the docs ("you do not have to do
  // this") and skipped entirely when no secret is configured — see decision
  // in the task brief and research doc §2b. When a secret IS configured, a
  // mismatch is logged and rejected with 401 rather than silently accepted.
  const apiSecret = process.env.ICYPEAS_API_SECRET;
  if (apiSecret) {
    const valid =
      typeof body.signature === "string" &&
      typeof body.timestamp === "string" &&
      verifyWebhookSignature(WEBHOOK_PATH, body.timestamp, body.signature, apiSecret);
    if (!valid) {
      console.error("[icypeas-webhook] signature verification failed", {
        hasSignature: Boolean(body.signature),
        hasTimestamp: Boolean(body.timestamp),
      });
      return Response.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  const item = body.data;
  if (!item) {
    return Response.json({ error: "Missing data" }, { status: 400 });
  }

  const target = parseExternalId(item.userData?.externalId);
  if (!target) {
    // Not one of ours (or missing externalId) — ack anyway so Icypeas
    // doesn't retry a payload we'll never be able to route.
    console.warn("[icypeas-webhook] no routable externalId on payload", {
      externalId: item.userData?.externalId,
      itemId: item._id,
    });
    return Response.json({ ok: true, skipped: "no externalId" });
  }

  const mapped = mapCertainty(item);

  if (!mapped.terminal) {
    // A webhook should only ever fire once the item is done, but be
    // defensive in case Icypeas ever sends an interim update.
    return Response.json({ ok: true, skipped: "non-terminal status" });
  }

  if (!mapped.status) {
    // Terminal but error (BAD_INPUT/INSUFFICIENT_FUNDS/ABORTED per research
    // doc §5c) — per decision #2, do NOT overwrite the row; leave whatever
    // status it had (likely still "verifying") and just log the failure so
    // it's diagnosable. A stuck "verifying" row is a known tradeoff of the
    // async model — see report.
    console.error("[icypeas-webhook] verification errored, leaving row unchanged", {
      table: target.table,
      id: target.id,
      icypeasStatus: item.status,
    });
    return Response.json({ ok: true, skipped: `error status ${item.status}` });
  }

  const { error } = await supabaseAdmin
    .from(target.table)
    .update({ email_status: mapped.status, email_verified_at: new Date().toISOString() })
    .eq("id", target.id);

  if (error) {
    console.error("[icypeas-webhook] failed to write result", {
      table: target.table,
      id: target.id,
      error: error.message,
    });
    return Response.json({ error: error.message }, { status: 500 });
  }

  if (target.table === "people") invalidatePeopleListCache();
  else invalidateCompaniesListCache();

  return Response.json({ ok: true });
}
