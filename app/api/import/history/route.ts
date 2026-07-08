import { supabaseAdmin } from "@/lib/supabase/admin";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

export async function GET() {
  if (!(await getUser())) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Excludes failed_records: it's an uncapped jsonb blob (one entry per
  // failed row, full record) that can grow to megabytes per run. Pulling it
  // for 50 rows on every history load was slow enough to hit the statement
  // timeout; the detail is fetched lazily per-row instead (see [id]/route.ts).
  const { data: history, error: historyErr } = await supabaseAdmin
    .from("import_history")
    .select(
      "id, source_key, target_table, tags, input_count, deduped_count, inserted_count, updated_count, failed_count, started_at, completed_at"
    )
    .order("completed_at", { ascending: false })
    .limit(50);

  if (historyErr) {
    return Response.json({ error: historyErr.message }, { status: 500 });
  }

  if (!history || history.length === 0) {
    return Response.json([]);
  }

  // Look up display names from provider_mappings
  const sourceKeys = [...new Set(history.map((r) => r.source_key))];
  const { data: mappings } = await supabaseAdmin
    .from("import_provider_mappings")
    .select("source_key, display_name")
    .in("source_key", sourceKeys);

  const displayNameMap: Record<string, string> = {};
  for (const m of mappings ?? []) {
    displayNameMap[m.source_key] = m.display_name;
  }

  const rows = history.map((r) => ({
    ...r,
    display_name: displayNameMap[r.source_key] ?? r.source_key,
  }));

  return Response.json(rows);
}
