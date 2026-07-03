import type { NextRequest } from "next/server";
import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { IMPORT_BUCKET } from "@/lib/import/storage";

export const dynamic = "force-dynamic";

const IMPORT_TOKEN = "scaletopia-import-2026";

async function ensureBucket(): Promise<void> {
  const { data: bucket } = await supabaseAdmin.storage.getBucket(IMPORT_BUCKET);
  if (bucket) return;

  const { error } = await supabaseAdmin.storage.createBucket(IMPORT_BUCKET, {
    public: false,
  });
  // Ignore "already exists" races from concurrent requests; surface anything else.
  if (error && !/already exists/i.test(error.message)) {
    throw error;
  }
}

export async function POST(request: NextRequest) {
  const token = request.headers.get("X-Import-Token");
  if (token !== IMPORT_TOKEN) {
    return new Response("Unauthorized", { status: 401 });
  }

  try {
    await ensureBucket();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(`Failed to prepare storage bucket: ${message}`, { status: 500 });
  }

  const path = `imports/${randomUUID()}.csv`;

  const { data, error } = await supabaseAdmin.storage
    .from(IMPORT_BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data) {
    const message = error instanceof Error ? error.message : "unknown error";
    return new Response(`Failed to create signed upload URL: ${message}`, { status: 500 });
  }

  return Response.json(data);
}
