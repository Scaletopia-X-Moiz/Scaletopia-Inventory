import { reverifyPhoneRecord } from "@/lib/verify/reverify-phone";
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
    outcome = await reverifyPhoneRecord("companies", id);
  } catch (err) {
    const message = (err as Error).message;
    await logActivity(
      "verify.reverify_one",
      { target: "companies", kind: "phone", id, error: message, failed: true },
      user
    );
    return Response.json({ error: message }, { status: 500 });
  }

  if (!outcome.ok) {
    const status =
      outcome.code === "not_found" ? 404 : outcome.code === "no_phone" ? 400 : 502;
    return Response.json({ error: outcome.message }, { status });
  }

  await logActivity(
    "verify.reverify_one",
    { target: "companies", kind: "phone", id },
    user
  );

  return Response.json({
    phone: outcome.phone,
    phoneStatus: outcome.status,
    phoneType: outcome.lineType,
    phoneVerifiedAt: outcome.verifiedAt,
  });
}
