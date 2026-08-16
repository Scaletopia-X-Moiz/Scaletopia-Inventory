import { reverifyRecord } from "@/lib/verify/reverify";
import { getUser } from "@/lib/auth/dal";
import { logActivity } from "@/lib/activity/log";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let outcome;
  try {
    outcome = await reverifyRecord("people", id);
  } catch (err) {
    const message = (err as Error).message;
    await logActivity(
      "verify.reverify_one",
      { target: "people", kind: "email", id, error: message, failed: true },
      user
    );
    return Response.json({ error: message }, { status: 500 });
  }

  if (!outcome.ok) {
    const status =
      outcome.code === "not_found" ? 404 : outcome.code === "no_email" ? 400 : 502;
    return Response.json({ error: outcome.message }, { status });
  }

  await logActivity(
    "verify.reverify_one",
    { target: "people", kind: "email", id, pending: outcome.pending },
    user
  );

  // No webhook configured (local dev) resolves inline and returns the final
  // verdict; with a webhook configured this returns immediately with
  // `pending: true` — the webhook receiver (app/api/internal/icypeas-webhook)
  // writes the real result when Icypeas calls back.
  if (outcome.pending) {
    return Response.json(
      { email: outcome.email, emailStatus: outcome.status, pending: true },
      { status: 202 }
    );
  }

  return Response.json({
    email: outcome.email,
    emailStatus: outcome.status,
    certainty: outcome.certainty,
    credits: outcome.credits,
    emailVerifiedAt: outcome.verifiedAt,
    pending: false,
  });
}
