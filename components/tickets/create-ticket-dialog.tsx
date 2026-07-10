"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Loader2, Plus, X } from "lucide-react";
import { createTicketAction, type ActionState } from "@/app/tickets/actions";

export function CreateTicketDialog() {
  const [open, setOpen] = useState(false);
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    createTicketAction,
    undefined
  );
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    if (state?.success) {
      formRef.current?.reset();
      setOpen(false);
    }
  }, [state]);

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

          <form ref={formRef} action={action} className="flex flex-col gap-3">
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
                disabled={pending}
                className="flex items-center justify-center gap-2 rounded-lg bg-stamp px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {pending ? <Loader2 size={15} className="animate-spin" /> : null}
                Create ticket
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
