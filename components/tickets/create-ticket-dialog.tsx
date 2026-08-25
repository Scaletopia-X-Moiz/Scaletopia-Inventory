"use client";

import { useActionState, useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Dialog } from "radix-ui";
import { Loader2, Plus, X } from "lucide-react";
import { createTicketAction, type ActionState } from "@/app/tickets/actions";
import { AttachmentPicker } from "@/components/tickets/attachment-picker";
import { VoiceRecorder } from "@/components/tickets/voice-recorder";
import { PRIORITY_LABEL, PRIORITY_OPTIONS } from "@/lib/tickets/priority";
import type { UploadedAttachment } from "@/lib/tickets/attachment-upload";

export function CreateTicketDialog() {
  const [open, setOpen] = useState(false);
  const [attachments, setAttachments] = useState<UploadedAttachment[]>([]);
  const [imageBusy, setImageBusy] = useState(false);
  const [voiceBusy, setVoiceBusy] = useState(false);
  const [stopSignal, setStopSignal] = useState(0);
  const [awaitingSubmit, setAwaitingSubmit] = useState(false);
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    createTicketAction,
    undefined
  );
  const formRef = useRef<HTMLFormElement>(null);
  // Late upload/onChange callbacks from a session that already closed (or
  // just got reset on success) must not repopulate attachments — see the
  // open/close effects below.
  const acceptRef = useRef(true);

  const busy = imageBusy || voiceBusy;

  useEffect(() => {
    if (state?.success) {
      acceptRef.current = false;
      formRef.current?.reset();
      setAttachments([]);
      setOpen(false);
    }
  }, [state]);

  // Always start a session with a clean slate — attachments are parent
  // state that would otherwise survive across opens (the dialog content
  // unmounts on close, but this component doesn't).
  useEffect(() => {
    if (open) {
      acceptRef.current = true;
      setAttachments([]);
      setAwaitingSubmit(false);
      formRef.current?.reset();
    } else {
      acceptRef.current = false;
    }
  }, [open]);

  // Once every in-flight upload/recording has settled, actually submit —
  // this re-enters handleSubmit, which now sees busy === false.
  useEffect(() => {
    if (awaitingSubmit && !busy) {
      setAwaitingSubmit(false);
      formRef.current?.requestSubmit();
    }
  }, [awaitingSubmit, busy]);

  // Children emit add/remove *intentions*; the parent owns the list and
  // applies them with functional updates. This is deliberate: the old
  // "child sends the full next list" contract captured `value` in a stale
  // closure at upload/record start, so a second attachment added while the
  // first was still settling would overwrite the first (e.g. recording a
  // voice note wiped an image dropped moments earlier). Functional updates
  // are immune to that race.
  const addAttachment = useCallback((item: UploadedAttachment) => {
    // Ignore late arrivals from a session that already reset/closed.
    if (!acceptRef.current) return;
    setAttachments((prev) => [...prev, item]);
  }, []);

  const removeAttachment = useCallback((storagePath: string) => {
    setAttachments((prev) => prev.filter((a) => a.storagePath !== storagePath));
  }, []);

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    if (busy) {
      e.preventDefault();
      setAwaitingSubmit(true);
      setStopSignal((n) => n + 1);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>
        <button
          type="button"
          className="flex items-center justify-center gap-2 rounded-lg bg-stamp px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90"
        >
          <Plus size={15} />
          Add Ticket
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed left-1/2 top-1/2 z-50 w-full max-w-lg -translate-x-1/2 -translate-y-1/2 rounded-xl border border-rule bg-card p-5 shadow-xl outline-none">
          <div className="mb-4 flex items-start justify-between gap-3">
            <div>
              <Dialog.Title className="text-sm font-semibold text-ink">New ticket</Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-ink-soft">
                Report a bug, request a feature, or suggest an improvement.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-hover"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <form ref={formRef} action={action} onSubmit={handleSubmit} className="flex flex-col gap-3">
            <div>
              <label htmlFor="ticket-title" className="mb-1 block text-xs font-medium text-ink-soft">
                Title
              </label>
              <input
                id="ticket-title"
                name="title"
                type="text"
                required
                maxLength={200}
                placeholder="Short summary"
                className="w-full rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
              />
            </div>

            <div>
              <label htmlFor="ticket-category" className="mb-1 block text-xs font-medium text-ink-soft">
                Category
              </label>
              <select
                id="ticket-category"
                name="category"
                required
                defaultValue="bug"
                className="w-full rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
              >
                <option value="bug">Bug</option>
                <option value="feature_request">Feature request</option>
                <option value="improvement">Improvement</option>
              </select>
            </div>

            <div>
              <label htmlFor="ticket-priority" className="mb-1 block text-xs font-medium text-ink-soft">
                Priority
              </label>
              <select
                id="ticket-priority"
                name="priority"
                required
                defaultValue="medium"
                className="w-full rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
              >
                {PRIORITY_OPTIONS.map((option) => (
                  <option key={option} value={option}>
                    {PRIORITY_LABEL[option]}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="ticket-description" className="mb-1 block text-xs font-medium text-ink-soft">
                Description
              </label>
              <textarea
                id="ticket-description"
                name="description"
                required
                rows={5}
                placeholder="What's going on? Steps to reproduce, expected behavior, etc."
                className="w-full resize-none rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
              />
            </div>

            <div>
              <label className="mb-1 block text-xs font-medium text-ink-soft">
                Attachments <span className="font-normal text-ink-mute">(optional)</span>
              </label>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <AttachmentPicker
                  value={attachments}
                  onAdd={addAttachment}
                  onRemove={removeAttachment}
                  disabled={pending}
                  onBusyChange={setImageBusy}
                />
                <VoiceRecorder
                  value={attachments}
                  onAdd={addAttachment}
                  onRemove={removeAttachment}
                  disabled={pending}
                  onBusyChange={setVoiceBusy}
                  stopSignal={stopSignal}
                />
              </div>
            </div>
            <input
              type="hidden"
              name="attachments"
              value={JSON.stringify(
                attachments.map((item) => ({
                  storagePath: item.storagePath,
                  kind: item.kind,
                  mimeType: item.mimeType,
                  sizeBytes: item.sizeBytes,
                  durationMs: item.durationMs,
                  originalName: item.originalName,
                }))
              )}
              readOnly
            />

            {state?.error && <p className="text-xs text-danger">{state.error}</p>}

            <div className="mt-1 flex justify-end gap-2">
              <Dialog.Close asChild>
                <button
                  type="button"
                  className="rounded-lg border border-rule px-4 py-2 text-sm text-ink-soft transition-colors hover:bg-hover"
                >
                  Cancel
                </button>
              </Dialog.Close>
              <button
                type="submit"
                disabled={pending || awaitingSubmit}
                className="flex items-center justify-center gap-2 rounded-lg bg-stamp px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {pending || awaitingSubmit ? <Loader2 size={15} className="animate-spin" /> : null}
                {awaitingSubmit ? "Finishing…" : "Create ticket"}
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
