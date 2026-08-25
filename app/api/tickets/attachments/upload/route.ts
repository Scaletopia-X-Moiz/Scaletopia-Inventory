import { supabaseAdmin } from "@/lib/supabase/admin";
import { getUser } from "@/lib/auth/dal";
import {
  TICKET_ATTACHMENTS_BUCKET,
  buildTicketAttachmentPath,
  ensureTicketAttachmentsBucket,
  isAllowedAudioType,
  isAllowedImageType,
  MAX_AUDIO_BYTES,
  MAX_IMAGE_BYTES,
  normalizeMimeType,
} from "@/lib/tickets/storage";

export const dynamic = "force-dynamic";

interface UploadRequestBody {
  mimeType?: string;
  sizeBytes?: number;
  ticketId?: number;
}

export async function POST(request: Request) {
  if (!(await getUser())) {
    return new Response("Unauthorized", { status: 401 });
  }

  let body: UploadRequestBody;
  try {
    body = await request.json();
  } catch {
    return new Response("Invalid JSON body", { status: 400 });
  }

  const mimeType = normalizeMimeType(String(body.mimeType ?? ""));
  const sizeBytes = Number(body.sizeBytes);
  const ticketId = Number.isFinite(body.ticketId) ? Number(body.ticketId) : undefined;

  const isImage = isAllowedImageType(mimeType);
  const isAudio = isAllowedAudioType(mimeType);
  if (!isImage && !isAudio) {
    return new Response("Unsupported file type.", { status: 400 });
  }

  if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
    return new Response("Invalid file size.", { status: 400 });
  }

  const maxBytes = isImage ? MAX_IMAGE_BYTES : MAX_AUDIO_BYTES;
  if (sizeBytes > maxBytes) {
    return new Response(`File too large (max ${Math.round(maxBytes / (1024 * 1024))}MB).`, {
      status: 400,
    });
  }

  try {
    await ensureTicketAttachmentsBucket();
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return new Response(`Failed to prepare storage bucket: ${message}`, { status: 500 });
  }

  const path = buildTicketAttachmentPath(ticketId ?? "pending", mimeType);

  const { data, error } = await supabaseAdmin.storage
    .from(TICKET_ATTACHMENTS_BUCKET)
    .createSignedUploadUrl(path);

  if (error || !data) {
    const message = error instanceof Error ? error.message : "unknown error";
    return new Response(`Failed to create signed upload URL: ${message}`, { status: 500 });
  }

  return Response.json({ ...data, kind: isImage ? "image" : "audio" });
}
