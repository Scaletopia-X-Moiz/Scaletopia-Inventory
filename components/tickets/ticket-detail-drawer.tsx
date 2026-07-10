"use client";

import { useActionState, useEffect, useState } from "react";
import { Dialog } from "radix-ui";
import { Loader2, Trash2, X } from "lucide-react";
import { timeAgo } from "@/lib/utils";
import type { Role } from "@/lib/auth/dal";
import type { TicketRow } from "@/lib/data/tickets";
import { CategoryBadge } from "@/components/tickets/category-badge";
import { StatusBadge } from "@/components/tickets/status-badge";
import {
  deleteTicketAction,
  updateTicketContentAction,
  updateTicketNoteAction,
  updateTicketStatusAction,
  type ActionState,
} from "@/app/tickets/actions";

const fieldClass =
  "w-full rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp";

function ContentEditor({ ticket }: { ticket: TicketRow }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    updateTicketContentAction,
    undefined
  );

  return (
    <form action={action} className="flex flex-col gap-3">
      <input type="hidden" name="id" value={ticket.id} />
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-soft">Title</label>
        <input name="title" defaultValue={ticket.title} required className={fieldClass} />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-soft">Category</label>
        <select name="category" defaultValue={ticket.category} className={fieldClass}>
          <option value="bug">Bug</option>
          <option value="feature_request">Feature request</option>
          <option value="improvement">Improvement</option>
        </select>
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-ink-soft">Description</label>
        <textarea
          name="description"
          defaultValue={ticket.description}
          required
          rows={5}
          className={`${fieldClass} resize-none`}
        />
      </div>
      {state?.error && <p className="text-xs text-danger">{state.error}</p>}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-2 rounded-lg bg-stamp px-3 py-1.5 text-xs font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {pending ? <Loader2 size={13} className="animate-spin" /> : null}
          Save changes
        </button>
      </div>
    </form>
  );
}

function StatusEditor({ ticket }: { ticket: TicketRow }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    updateTicketStatusAction,
    undefined
  );

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={ticket.id} />
      <label className="text-xs font-medium text-ink-soft">Status</label>
      <div className="flex items-center gap-2">
        <select
          name="status"
          defaultValue={ticket.status}
          onChange={(e) => e.currentTarget.form?.requestSubmit()}
          disabled={pending}
          className={`${fieldClass} max-w-[200px]`}
        >
          <option value="open">Open</option>
          <option value="in_progress">In progress</option>
          <option value="done">Done</option>
        </select>
        {pending ? <Loader2 size={14} className="animate-spin text-ink-soft" /> : null}
      </div>
      {state?.error && <p className="text-xs text-danger">{state.error}</p>}
    </form>
  );
}

function NoteEditor({ ticket }: { ticket: TicketRow }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    updateTicketNoteAction,
    undefined
  );

  return (
    <form action={action} className="flex flex-col gap-2">
      <input type="hidden" name="id" value={ticket.id} />
      <label className="text-xs font-medium text-ink-soft">Note</label>
      <textarea
        name="note"
        defaultValue={ticket.currentNote ?? ""}
        rows={3}
        placeholder="Add context, progress, or a resolution note for the reporter…"
        className={`${fieldClass} resize-none`}
      />
      {state?.error && <p className="text-xs text-danger">{state.error}</p>}
      <div className="flex justify-end">
        <button
          type="submit"
          disabled={pending}
          className="flex items-center gap-2 rounded-lg border border-rule px-3 py-1.5 text-xs font-medium text-ink transition-colors hover:bg-hover disabled:opacity-60"
        >
          {pending ? <Loader2 size={13} className="animate-spin" /> : null}
          Save note
        </button>
      </div>
    </form>
  );
}

function DeleteButton({ ticket, onDeleted }: { ticket: TicketRow; onDeleted: () => void }) {
  const [state, action, pending] = useActionState<ActionState | undefined, FormData>(
    deleteTicketAction,
    undefined
  );

  useEffect(() => {
    if (state?.success) onDeleted();
  }, [state, onDeleted]);

  return (
    <form action={action}>
      <input type="hidden" name="id" value={ticket.id} />
      {state?.error && <p className="mb-2 text-xs text-danger">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-danger transition-colors hover:bg-danger/10 disabled:opacity-60"
      >
        {pending ? <Loader2 size={13} className="animate-spin" /> : <Trash2 size={13} />}
        Delete ticket
      </button>
    </form>
  );
}

interface TicketDetailDrawerProps {
  ticket: TicketRow;
  viewerRole: Role;
  viewerId: string;
  children: React.ReactNode;
}

export function TicketDetailDrawer({ ticket, viewerRole, viewerId, children }: TicketDetailDrawerProps) {
  const [open, setOpen] = useState(false);
  const canManage = viewerRole === "admin" || viewerRole === "dev";
  const canChangeStatus = viewerRole === "dev";
  const isOwnTicket = ticket.createdBy === viewerId;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Trigger asChild>{children}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-rule bg-card outline-none data-[state=open]:animate-drawer-in data-[state=closed]:animate-drawer-out">
          <div className="flex items-start justify-between gap-3 border-b border-rule px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-sm font-semibold text-ink">
                Ticket #{ticket.id}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 flex items-center gap-1.5 text-xs text-ink-soft">
                <CategoryBadge category={ticket.category} />
                <StatusBadge status={ticket.status} />
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

          <div className="flex-1 overflow-y-auto px-5 py-4">
            {canManage ? (
              <div className="flex flex-col gap-5">
                <ContentEditor ticket={ticket} />
                {canChangeStatus && <StatusEditor ticket={ticket} />}
                <NoteEditor ticket={ticket} />
                <div className="text-xs text-ink-mute">
                  Reported by {ticket.createdByEmail ?? "unknown"} · {timeAgo(ticket.createdAt)}
                </div>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div>
                  <p className="mb-1 text-xs font-medium text-ink-soft">Title</p>
                  <p className="text-sm text-ink">{ticket.title}</p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-ink-soft">Description</p>
                  <p className="whitespace-pre-wrap text-sm text-ink">{ticket.description}</p>
                </div>
                <div>
                  <p className="mb-1 text-xs font-medium text-ink-soft">Note</p>
                  {ticket.currentNote ? (
                    <>
                      <p className="whitespace-pre-wrap text-sm text-ink">{ticket.currentNote}</p>
                      <p className="mt-1 text-xs text-ink-mute">
                        — {ticket.noteUpdatedByEmail ?? "unknown"}
                        {ticket.noteUpdatedAt ? `, ${timeAgo(ticket.noteUpdatedAt)}` : ""}
                      </p>
                    </>
                  ) : (
                    <p className="text-sm text-ink-soft">No note yet.</p>
                  )}
                </div>
                <div className="text-xs text-ink-mute">
                  {isOwnTicket ? "Reported by you" : `Reported by ${ticket.createdByEmail ?? "unknown"}`} ·{" "}
                  {timeAgo(ticket.createdAt)}
                </div>
              </div>
            )}
          </div>

          {canManage && (
            <div className="border-t border-rule px-5 py-3">
              <DeleteButton ticket={ticket} onDeleted={() => setOpen(false)} />
            </div>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
