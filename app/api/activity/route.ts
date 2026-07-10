import type { NextRequest } from "next/server";
import { getUser } from "@/lib/auth/dal";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { ActivityRow } from "@/app/activity/activity-view";

export const dynamic = "force-dynamic";

export const ACTIVITY_PAGE_SIZE = 200;

/** Paginated fetch backing the "Load more" button on /activity. Admin/dev
 * only, mirroring the page's own `requireAdminOrDev()` gate. */
export async function GET(request: NextRequest) {
  const user = await getUser();
  if (!user || (user.role !== "admin" && user.role !== "dev")) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const offset = Number(request.nextUrl.searchParams.get("offset") ?? "0");
  const from = Number.isFinite(offset) && offset >= 0 ? offset : 0;
  const to = from + ACTIVITY_PAGE_SIZE - 1;

  const { data, error } = await supabaseAdmin
    .from("activity_log")
    .select("id, user_email, action, details, created_at")
    .order("created_at", { ascending: false })
    .range(from, to);

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  const rows = (data ?? []) as ActivityRow[];
  return Response.json({ rows, hasMore: rows.length === ACTIVITY_PAGE_SIZE });
}
