import { supabaseAdmin } from "@/lib/supabase/admin";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  if (!(await getUser())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await params;

  const { data, error } = await supabaseAdmin
    .from("import_history")
    .select("failed_records")
    .eq("id", id)
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ failed_records: data?.failed_records ?? [] });
}
