import "server-only";
import { randomUUID } from "crypto";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Private bucket for images/voice notes attached to tickets. Mirrors the
// bucket-per-purpose convention in lib/import/storage.ts.
export const TICKET_ATTACHMENTS_BUCKET = "ticket-attachments";

export const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const ALLOWED_AUDIO_TYPES = [
  "audio/webm",
  "audio/ogg",
  "audio/mpeg",
  "audio/mp4",
  "audio/wav",
] as const;

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB
export const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // 25MB

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/wav": "wav",
};

/**
 * Browser-produced mime types often carry codec parameters (e.g.
 * `audio/webm;codecs=opus` from MediaRecorder) that our whitelist and
 * extension map don't key on. Strip everything from the first `;` onward
 * and normalize case/whitespace before validating or mapping a mime type —
 * apply this at every boundary that receives a client-declared mime type.
 */
export function normalizeMimeType(mime: string): string {
  return mime.split(";")[0].trim().toLowerCase();
}

export function isAllowedImageType(mimeType: string): boolean {
  return (ALLOWED_IMAGE_TYPES as readonly string[]).includes(normalizeMimeType(mimeType));
}

export function isAllowedAudioType(mimeType: string): boolean {
  return (ALLOWED_AUDIO_TYPES as readonly string[]).includes(normalizeMimeType(mimeType));
}

export async function ensureTicketAttachmentsBucket(): Promise<void> {
  const { data: bucket } = await supabaseAdmin.storage.getBucket(TICKET_ATTACHMENTS_BUCKET);
  if (bucket) return;

  const { error } = await supabaseAdmin.storage.createBucket(TICKET_ATTACHMENTS_BUCKET, {
    public: false,
  });
  // Ignore "already exists" races from concurrent requests; surface anything else.
  if (error && !/already exists/i.test(error.message)) {
    throw error;
  }
}

/**
 * Storage path for a new attachment.
 *
 * Report attachments are uploaded from the create-ticket dialog *before* the
 * ticket row exists (there's no id yet to key the path on), so those go
 * under a `tickets/pending/{uuid}` staging path. Once createTicketAction
 * creates the ticket and links the attachment rows, we deliberately leave
 * the object at its staging path rather than moving it — storage_path in
 * the DB is the single source of truth for where the bytes live, so there's
 * no correctness reason to relocate it, only cosmetic tidiness. Note
 * attachments are uploaded against an existing ticket, so those go straight
 * under `tickets/{ticketId}/{uuid}`.
 */
export function buildTicketAttachmentPath(
  ticketId: number | "pending",
  mimeType: string
): string {
  const ext = EXTENSION_BY_MIME[normalizeMimeType(mimeType)] ?? "bin";
  return `tickets/${ticketId}/${randomUUID()}.${ext}`;
}
