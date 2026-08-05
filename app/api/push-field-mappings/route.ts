import type { NextRequest } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** GET/POST for the per-(client, platform) saved push mapping (ticket #114),
 * modeled directly on app/api/import/mappings/route.ts. `mapping` is stored
 * and returned opaque (jsonb) — its shape is whatever the calling push
 * button currently sends. */
export async function GET(request: NextRequest) {
  const clientId = request.nextUrl.searchParams.get("clientId");
  const platform = request.nextUrl.searchParams.get("platform");

  if (!clientId || !platform) {
    return Response.json({ error: "clientId and platform required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("push_field_mappings")
    .select("*")
    .eq("client_id", clientId)
    .eq("platform", platform)
    .single();

  if (error && error.code !== "PGRST116") {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json(data ?? null);
}

export async function POST(request: NextRequest) {
  let body: { clientId: string; platform: string; mapping: unknown };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const { clientId, platform, mapping } = body;

  if (!clientId || !platform || mapping === undefined) {
    return Response.json({ error: "clientId, platform, and mapping required" }, { status: 400 });
  }

  const { data, error } = await supabaseAdmin
    .from("push_field_mappings")
    .upsert(
      {
        client_id: clientId,
        platform,
        mapping,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "client_id,platform" }
    )
    .select("id")
    .single();

  if (error) {
    return Response.json({ error: error.message }, { status: 500 });
  }

  return Response.json({ id: data?.id });
}
