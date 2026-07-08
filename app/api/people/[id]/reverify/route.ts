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
    { target: "people", kind: "email", id },
    user
  );

  return Response.json({
    email: outcome.email,
    emailStatus: outcome.status,
    quality: outcome.quality,
    credits: outcome.credits,
    emailVerifiedAt: outcome.verifiedAt,
  });
}
