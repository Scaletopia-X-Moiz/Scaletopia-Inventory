// Browser-side helper for uploading ticket attachments directly to Supabase
// Storage via a signed upload URL, mirroring the pattern in app/import/page.tsx
// (see the storage-upload PUT around line 1680 there). No "use client"
// directive needed — this is a plain module, only ever imported from client
// components (attachment-picker.tsx, voice-recorder.tsx).

export type UploadedAttachmentKind = "image" | "audio";

export interface UploadedAttachment {
  storagePath: string;
  kind: UploadedAttachmentKind;
  mimeType: string;
  sizeBytes: number;
  durationMs?: number;
  originalName?: string;
  /** Client-only preview (object URL), never sent to the server. */
  previewUrl?: string;
}

interface SignUploadResponse {
  path: string;
  token: string;
  signedUrl: string;
  kind: UploadedAttachmentKind;
}

/** Requests a signed upload URL, PUTs the blob to Supabase Storage, and
 * returns the metadata the server needs to link the attachment to a ticket. */
export async function uploadTicketAttachment(
  blob: Blob,
  opts: { mimeType: string; originalName?: string; durationMs?: number; ticketId?: number }
): Promise<UploadedAttachment> {
  const signRes = await fetch("/api/tickets/attachments/upload", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mimeType: opts.mimeType,
      sizeBytes: blob.size,
      ticketId: opts.ticketId,
    }),
  });

  if (!signRes.ok) {
    const text = await signRes.text();
    throw new Error(text || `HTTP ${signRes.status}`);
  }

  const { path, signedUrl, kind } = (await signRes.json()) as SignUploadResponse;

  // Mirrors the wire format used by supabase-js's `uploadToSignedUrl` (PUT
  // with a multipart body containing an empty-named file field) — see
  // app/import/page.tsx for the precedent. We hit the signed URL directly
  // instead of instantiating a Supabase client since we have no anon key to
  // give a browser-side client, and the token embedded in signedUrl is all
  // the auth this endpoint needs.
  const uploadBody = new FormData();
  uploadBody.append("cacheControl", "3600");
  uploadBody.append("", blob);

  const uploadRes = await fetch(signedUrl, { method: "PUT", body: uploadBody });
  if (!uploadRes.ok) {
    const text = await uploadRes.text();
    throw new Error(text || `Upload failed: HTTP ${uploadRes.status}`);
  }

  return {
    storagePath: path,
    kind,
    mimeType: opts.mimeType,
    sizeBytes: blob.size,
    durationMs: opts.durationMs,
    originalName: opts.originalName,
  };
}
