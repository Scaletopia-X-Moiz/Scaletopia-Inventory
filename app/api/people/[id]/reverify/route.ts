import { reverifyRecord } from "@/lib/verify/reverify";

export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  let outcome;
  try {
    outcome = await reverifyRecord("people", id);
  } catch (err) {
    return Response.json({ error: (err as Error).message }, { status: 500 });
  }

  if (!outcome.ok) {
    const status =
      outcome.code === "not_found" ? 404 : outcome.code === "no_email" ? 400 : 502;
    return Response.json({ error: outcome.message }, { status });
  }

  return Response.json({
    email: outcome.email,
    emailStatus: outcome.status,
    quality: outcome.quality,
    credits: outcome.credits,
    emailVerifiedAt: outcome.verifiedAt,
  });
}
