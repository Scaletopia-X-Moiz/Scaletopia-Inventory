"use client";

import { useState } from "react";
import { Dialog } from "radix-ui";
import { Loader2, X, ArrowDownLeft, ArrowUpRight, Circle } from "lucide-react";
import { cn, ghlTimeAgo, formatAbsoluteDateTime } from "@/lib/utils";
import type { GhlMessageRow } from "@/lib/data/ghl-activity";

/** The "Last activity" cell in the People table: relative time, and on click a
 * right-side drawer with that person's full GHL message history.
 *
 * Copies components/companies/people-drawer-trigger.tsx — Radix Dialog as a
 * right drawer, lazy `fetch()` on first open, cached in state for the life of
 * the row, explicit loading/error branches. The differences are that this one
 * is a table cell rather than an icon button (so the whole cell is the
 * trigger), and that it renders nothing clickable when there is no activity:
 * an empty cell means "nothing has happened with this lead", and a drawer that
 * opens onto "No messages" is a worse answer than no drawer.
 *
 * History comes from our own database, never live from GHL — see
 * getPersonGhlMessages. */
export function ActivityDrawerTrigger({
  personId,
  personName,
  lastActivityAt,
}: {
  personId: string;
  personName: string | null;
  lastActivityAt: string | null | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<GhlMessageRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  if (!lastActivityAt) {
    // Blank, exactly like the GHL Contacts list shows for a contact with no
    // qualifying message.
    return <td className="whitespace-nowrap px-3 py-2.5 text-ink-soft" />;
  }

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next && messages === null && !loading) {
      setLoading(true);
      setError(false);
      fetch(`/api/people/${personId}/ghl-activity`)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status}`);
          return r.json();
        })
        .then((data: { messages: GhlMessageRow[] }) => {
          setMessages(data.messages);
          setLoading(false);
        })
        .catch(() => {
          setLoading(false);
          setError(true);
        });
    }
  }

  return (
    <td className="p-0">
      <Dialog.Root open={open} onOpenChange={handleOpenChange}>
        <Dialog.Trigger asChild>
          <button
            type="button"
            title={formatAbsoluteDateTime(lastActivityAt)}
            className="block w-full whitespace-nowrap px-3 py-2.5 text-left text-ink underline-offset-2 hover:underline group-hover:bg-rule/30"
            aria-label={`Last activity ${ghlTimeAgo(lastActivityAt)} — open message history for ${personName ?? "this person"}`}
          >
            {ghlTimeAgo(lastActivityAt)}
          </button>
        </Dialog.Trigger>

        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
          <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-rule bg-card outline-none data-[state=open]:animate-drawer-in data-[state=closed]:animate-drawer-out">
            <div className="flex items-start justify-between gap-3 border-b border-rule px-5 py-4">
              <div className="min-w-0">
                <Dialog.Title className="truncate text-sm font-semibold text-ink">
                  {personName ?? "Person"}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-xs text-ink-soft">
                  GHL message history · last activity {ghlTimeAgo(lastActivityAt)}
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

            <div className="flex-1 overflow-y-auto px-2 py-2">
              {loading ? (
                <div className="flex items-center justify-center py-10 text-ink-soft">
                  <Loader2 size={16} className="animate-spin" />
                </div>
              ) : error ? (
                <p className="px-3 py-4 text-sm text-ink-soft">Failed to load messages. Try again.</p>
              ) : messages && messages.length > 0 ? (
                <ul className="flex flex-col gap-1">
                  {messages.map((message) => (
                    <MessageItem key={message.id} message={message} />
                  ))}
                </ul>
              ) : (
                <p className="px-3 py-4 text-sm text-ink-soft">
                  No messages stored yet. Refresh last activity to pull this contact&apos;s history from
                  GHL.
                </p>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </td>
  );
}

/** GHL's own `TYPE_SMS` / `TYPE_EMAIL` / … spelling is machine-facing; the
 * drawer shows the channel the way a person would say it. Unrecognized types
 * fall back to the raw value with the prefix stripped, so a channel GHL adds
 * later reads as "WHATSAPP" rather than disappearing. */
function messageTypeLabel(type: string | null): string {
  if (!type) return "Message";
  const known: Record<string, string> = {
    TYPE_SMS: "SMS",
    TYPE_EMAIL: "Email",
    TYPE_CALL: "Call",
    TYPE_VOICEMAIL: "Voicemail",
    TYPE_FACEBOOK: "Facebook",
    TYPE_GMB: "Google Business",
    TYPE_INSTAGRAM: "Instagram",
    TYPE_WHATSAPP: "WhatsApp",
    TYPE_LIVE_CHAT: "Live chat",
    TYPE_REVIEW: "Review",
  };
  return known[type] ?? type.replace(/^TYPE_/, "").replace(/_/g, " ");
}

function MessageItem({ message }: { message: GhlMessageRow }) {
  const inbound = message.direction === "inbound";
  const outbound = message.direction === "outbound";

  return (
    <li className="rounded-md px-3 py-2.5 hover:bg-hover">
      <div className="flex items-center gap-1.5 text-xs text-ink-soft">
        {inbound ? (
          <ArrowDownLeft size={12} className="shrink-0 text-stamp" />
        ) : outbound ? (
          <ArrowUpRight size={12} className="shrink-0 text-ink-mute" />
        ) : (
          <Circle size={10} className="shrink-0 text-ink-mute" />
        )}
        <span className={cn("font-medium", inbound && "text-stamp")}>
          {messageTypeLabel(message.messageType)}
        </span>
        {message.direction && <span>· {message.direction}</span>}
        <span className="ml-auto shrink-0 tabular-nums" title={formatAbsoluteDateTime(message.occurredAt)}>
          {ghlTimeAgo(message.occurredAt)}
        </span>
      </div>
      {message.body ? (
        <p className="mt-1 line-clamp-6 text-sm whitespace-pre-wrap text-ink">{message.body}</p>
      ) : (
        <p className="mt-1 text-sm text-ink-mute italic">No message text</p>
      )}
      {message.clientName && (
        <p className="mt-1 text-[11px] text-ink-mute">{message.clientName}</p>
      )}
    </li>
  );
}
