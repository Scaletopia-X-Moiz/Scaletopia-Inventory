"use client";

import { useEffect, useRef, useState } from "react";
import { Image as ImageIcon, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { uploadTicketAttachment, type UploadedAttachment } from "@/lib/tickets/attachment-upload";

const ACCEPT = "image/png,image/jpeg,image/webp,image/gif";
const MAX_FILES = 10;

interface PendingItem {
  key: string;
  previewUrl: string;
  status: "uploading" | "error";
  error?: string;
}

/** File input + drag/drop for image attachments. Controlled: `value` is the
 * list of already-uploaded items, `onChange` is called with the full next
 * list every time an upload finishes or an item is removed. Each file is
 * uploaded to storage the moment it's selected — `value` only ever holds
 * items that have already made it to Supabase Storage. */
export function AttachmentPicker({
  value,
  onAdd,
  onRemove,
  ticketId,
  disabled,
  onBusyChange,
}: {
  value: UploadedAttachment[];
  /** Called once per image the moment its upload lands. The parent merges it
   * with a functional update, so concurrent adds from here and the voice
   * recorder never clobber each other. */
  onAdd: (item: UploadedAttachment) => void;
  onRemove: (storagePath: string) => void;
  ticketId?: number;
  disabled?: boolean;
  /** Reports whether any upload is in flight, so the parent can hold off
   * submitting the ticket form until every image lands. */
  onBusyChange?: (busy: boolean) => void;
}) {
  const [pending, setPending] = useState<PendingItem[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    onBusyChange?.(pending.some((p) => p.status === "uploading"));
  }, [pending, onBusyChange]);

  async function addFiles(files: FileList | File[]) {
    const room = MAX_FILES - value.length - pending.length;
    if (room <= 0) return;
    const list = Array.from(files).slice(0, room);

    for (const file of list) {
      const key = `${file.name}-${file.size}-${Date.now()}-${Math.random()}`;
      const previewUrl = URL.createObjectURL(file);
      setPending((prev) => [...prev, { key, previewUrl, status: "uploading" }]);

      try {
        const attachment = await uploadTicketAttachment(file, {
          mimeType: file.type,
          originalName: file.name,
          ticketId,
        });
        setPending((prev) => prev.filter((p) => p.key !== key));
        onAdd({ ...attachment, previewUrl });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Upload failed.";
        setPending((prev) =>
          prev.map((p) => (p.key === key ? { ...p, status: "error", error: message } : p))
        );
      }
    }
  }

  function removeUploaded(storagePath: string) {
    const item = value.find((a) => a.storagePath === storagePath);
    if (item?.previewUrl) URL.revokeObjectURL(item.previewUrl);
    onRemove(storagePath);
  }

  // `value` may be a combined list shared with VoiceRecorder (see
  // create-ticket-dialog.tsx) — only render/count the image half here.
  const imageItems = value.filter((a) => a.kind === "image");

  function removePending(key: string) {
    setPending((prev) => {
      const item = prev.find((p) => p.key === key);
      if (item) URL.revokeObjectURL(item.previewUrl);
      return prev.filter((p) => p.key !== key);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          if (!disabled) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          if (!disabled && e.dataTransfer.files.length) void addFiles(e.dataTransfer.files);
        }}
        className={cn(
          "flex min-h-[76px] flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-rule px-3 py-3 text-center text-xs text-ink-soft transition-colors",
          dragOver && "border-stamp bg-hover"
        )}
      >
        <ImageIcon size={14} />
        <span>Drag images here</span>
        <button
          type="button"
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className="font-medium text-stamp hover:underline disabled:opacity-60"
        >
          or browse
        </button>
        <input
          ref={inputRef}
          type="file"
          accept={ACCEPT}
          multiple
          hidden
          disabled={disabled}
          onChange={(e) => {
            if (e.target.files?.length) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {(imageItems.length > 0 || pending.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {imageItems.map((a) => (
            <div
              key={a.storagePath}
              className="group relative size-16 overflow-hidden rounded-lg border border-rule bg-paper"
            >
              {a.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={a.previewUrl} alt="" className="size-full object-cover" />
              ) : null}
              <button
                type="button"
                disabled={disabled}
                onClick={() => removeUploaded(a.storagePath)}
                aria-label="Remove attachment"
                className="absolute right-0.5 top-0.5 rounded-full bg-black/60 p-0.5 text-white opacity-0 transition-opacity group-hover:opacity-100 disabled:opacity-60"
              >
                <X size={10} />
              </button>
            </div>
          ))}
          {pending.map((p) => (
            <div key={p.key} className="relative size-16 overflow-hidden rounded-lg border border-rule">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={p.previewUrl} alt="" className="size-full object-cover" />
              {p.status === "uploading" && (
                <div className="absolute inset-0 flex items-center justify-center bg-black/40">
                  <Loader2 size={16} className="animate-spin text-white" />
                </div>
              )}
              {p.status === "error" && (
                <button
                  type="button"
                  onClick={() => removePending(p.key)}
                  title={p.error}
                  className="absolute inset-0 flex items-center justify-center bg-danger/80 text-[10px] text-white"
                >
                  Retry
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
