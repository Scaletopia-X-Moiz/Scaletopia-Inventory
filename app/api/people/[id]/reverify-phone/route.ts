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
    outcome = await reverifyPhoneRecord("people", id);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }

  if (!outcome.ok) {
    const status =
      outcome.code === "not_found" ? 404 : outcome.code === "no_phone" ? 400 : 502;
    return Response.json({ error: outcome.message }, { status });
  }

  await logActivity(
    "verify.reverify_one",
    { target: "people", kind: "phone", id },
    user
  );

  return Response.json({
    phone: outcome.phone,
    phoneStatus: outcome.status,
    phoneType: outcome.lineType,
    phoneVerifiedAt: outcome.verifiedAt,
  });
}
