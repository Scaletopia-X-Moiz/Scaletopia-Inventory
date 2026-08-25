"use client";

import { useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import type { TicketAttachmentRow } from "@/lib/data/ticket-attachments";
import { removeTicketAttachmentAction } from "@/app/tickets/actions";

/** Presentational: images render as clickable thumbnails (opens the signed
 * URL full-size in a new tab), audio renders with a native <audio controls>
 * player. `onChanged` is called after a successful delete so the caller can
 * refetch attachments — this component doesn't own the attachment list, the
 * drawer does (attachments are lazily fetched, see ticket-detail-drawer.tsx). */
export function AttachmentList({
  attachments,
  ticketId,
  canRemove,
  onChanged,
}: {
  attachments: TicketAttachmentRow[];
  ticketId: number;
  canRemove?: boolean;
  onChanged?: () => void;
}) {
  const [removingId, setRemovingId] = useState<number | null>(null);

  if (attachments.length === 0) return null;

  async function remove(attachmentId: number) {
    setRemovingId(attachmentId);
    const formData = new FormData();
    formData.set("ticketId", String(ticketId));
    formData.set("attachmentId", String(attachmentId));
    await removeTicketAttachmentAction(undefined, formData);
    setRemovingId(null);
    onChanged?.();
  }

  const images = attachments.filter((a) => a.kind === "image");
  const audio = attachments.filter((a) => a.kind === "audio");

  return (
    <div className="flex flex-col gap-2">
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {images.map((a) => (
            <div
              key={a.id}
              className="group relative size-16 overflow-hidden rounded-lg border border-rule bg-paper"
            >
              {a.signedUrl ? (
                <a href={a.signedUrl} target="_blank" rel="noreferrer">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a.signedUrl} alt={a.originalName ?? "Attachment"} className="size-full object-cover" />
                </a>
              ) : (
                <div className="flex size-full items-center justify-center text-[10px] text-ink-soft">
                  Unavailable
                </div>
              )}
              {canRemove && (
                <button
                  type="button"
                  disabled={removingId === a.id}
                  onClick={() => void remove(a.id)}
                  aria-label="Remove attachment"
                  className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-1 text-white opacity-0 transition-opacity hover:bg-danger group-hover:opacity-100 disabled:opacity-60"
                >
                  {removingId === a.id ? (
                    <Loader2 size={11} className="animate-spin" />
                  ) : (
                    <Trash2 size={11} />
                  )}
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {audio.length > 0 && (
        <ul className="flex flex-col gap-2">
          {audio.map((a) => (
            <li
              key={a.id}
              className="flex items-center gap-2 rounded-lg border border-rule bg-paper px-2.5 py-2"
            >
              {a.signedUrl ? (
                <audio controls src={a.signedUrl} className="h-8 flex-1" />
              ) : (
                <span className="flex-1 text-xs text-ink-soft">Unavailable</span>
              )}
              {canRemove && (
                <button
                  type="button"
                  disabled={removingId === a.id}
                  onClick={() => void remove(a.id)}
                  aria-label="Remove attachment"
                  className="text-ink-soft hover:text-danger disabled:opacity-60"
                >
                  {removingId === a.id ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Trash2 size={13} />
                  )}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
