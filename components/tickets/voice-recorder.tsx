"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2, Mic, Music, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { uploadTicketAttachment, type UploadedAttachment } from "@/lib/tickets/attachment-upload";

const PREFERRED_RECORD_MIME_TYPE = "audio/webm;codecs=opus";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Record-only control for voice-note attachments. Controlled the same way
 * as AttachmentPicker: `value` is the already-uploaded list, `onChange` gets
 * the full next list. Recording uses MediaRecorder (feature-detected — the
 * control shows a fallback message in browsers/contexts without support). */
export function VoiceRecorder({
  value,
  onAdd,
  onRemove,
  ticketId,
  disabled,
  onBusyChange,
  stopSignal,
}: {
  value: UploadedAttachment[];
  /** Called once when a recorded/uploaded voice note lands. The parent merges
   * it with a functional update — see the note in create-ticket-dialog: the
   * old "send the full next list" contract closed over a stale `value` bound
   * at record start, which wiped attachments added in the meantime. */
  onAdd: (item: UploadedAttachment) => void;
  onRemove: (storagePath: string) => void;
  ticketId?: number;
  disabled?: boolean;
  /** Reports recording-or-uploading state up to the parent, so it can hold
   * off submitting the ticket form until any in-flight voice note lands. */
  onBusyChange?: (busy: boolean) => void;
  /** Bump this to force-stop an active recording (e.g. the parent is about
   * to submit). Ignored on initial mount and while not recording. */
  stopSignal?: number;
}) {
  const [supported, setSupported] = useState(true);
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const stopSignalMounted = useRef(false);

  useEffect(() => {
    const hasMic = typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia;
    const hasRecorder = typeof MediaRecorder !== "undefined";
    setSupported(hasMic && hasRecorder);
  }, []);

  useEffect(() => {
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      streamRef.current?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  useEffect(() => {
    onBusyChange?.(recording || uploading);
  }, [recording, uploading, onBusyChange]);

  useEffect(() => {
    if (!stopSignalMounted.current) {
      stopSignalMounted.current = true;
      return;
    }
    if (recording) stopRecording();
  }, [stopSignal]);

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mimeType = MediaRecorder.isTypeSupported(PREFERRED_RECORD_MIME_TYPE)
        ? PREFERRED_RECORD_MIME_TYPE
        : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType });
      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };
      recorder.onstop = () => {
        void finishRecording(mimeType);
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      startedAtRef.current = Date.now();
      setElapsedMs(0);
      setRecording(true);
      intervalRef.current = setInterval(() => {
        setElapsedMs(Date.now() - startedAtRef.current);
      }, 250);
    } catch {
      setError("Couldn't access the microphone. Check your browser permissions.");
    }
  }

  function stopRecording() {
    mediaRecorderRef.current?.stop();
    streamRef.current?.getTracks().forEach((t) => t.stop());
    if (intervalRef.current) clearInterval(intervalRef.current);
    setRecording(false);
  }

  async function finishRecording(mimeType: string) {
    const durationMs = Date.now() - startedAtRef.current;
    const blob = new Blob(chunksRef.current, { type: mimeType });
    chunksRef.current = [];
    if (blob.size === 0) return;

    setUploading(true);
    setError(null);
    try {
      const attachment = await uploadTicketAttachment(blob, { mimeType, durationMs, ticketId });
      onAdd(attachment);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setUploading(false);
    }
  }

  function removeUploaded(storagePath: string) {
    onRemove(storagePath);
  }

  // `value` may be a combined list shared with AttachmentPicker (see
  // create-ticket-dialog.tsx) — only render the audio half here.
  const audioItems = value.filter((a) => a.kind === "audio");

  return (
    <div className="flex flex-col gap-2">
      <div className="flex min-h-[76px] flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-rule px-3 py-3 text-center">
        {supported ? (
          <button
            type="button"
            disabled={disabled || uploading}
            onClick={recording ? stopRecording : () => void startRecording()}
            className={cn(
              "flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-60",
              recording ? "border-danger bg-danger/10 text-danger" : "border-rule text-ink hover:bg-hover"
            )}
          >
            {recording ? <Square size={13} /> : <Mic size={13} />}
            {recording ? `Stop · ${formatElapsed(elapsedMs)}` : "Record voice note"}
          </button>
        ) : (
          <p className="text-xs text-ink-soft">Recording isn&apos;t supported in this browser.</p>
        )}

        {uploading && <Loader2 size={14} className="animate-spin text-ink-soft" />}
      </div>


      {error && <p className="text-xs text-danger">{error}</p>}

      {audioItems.length > 0 && (
        <ul className="flex flex-col gap-1.5">
          {audioItems.map((a) => (
            <li
              key={a.storagePath}
              className="flex items-center gap-2 rounded-lg border border-rule bg-paper px-2.5 py-1.5"
            >
              <Music size={12} className="shrink-0 text-ink-soft" />
              <span className="flex-1 truncate text-xs text-ink">
                {a.originalName ?? "Voice note"}
                {a.durationMs ? ` · ${formatElapsed(a.durationMs)}` : ""}
              </span>
              <button
                type="button"
                disabled={disabled}
                onClick={() => removeUploaded(a.storagePath)}
                aria-label="Remove attachment"
                className="text-ink-soft hover:text-danger disabled:opacity-60"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
