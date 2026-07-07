import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const IMPORT_TOKEN = "scaletopia-import-2026";

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const token = req.headers.get("X-Import-Token");
  if (token !== IMPORT_TOKEN) {
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
