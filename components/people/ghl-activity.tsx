"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import {
  Loader2,
  X,
  Mail,
  MessageSquare,
  Phone,
  Voicemail,
  MessageCircle,
  RotateCw,
  ArrowDown,
} from "lucide-react";
import { cn, ghlTimeAgo, formatAbsoluteDateTime } from "@/lib/utils";
import type { GhlMessageRow } from "@/lib/data/ghl-activity";

/* ---------- shared fetch ----------
 * One in-flight/settled request per person for the life of the page, shared by
 * the People table cell, the person detail card and the drawer, so opening the
 * drawer after the card has loaded costs no second request. Failures are
 * evicted so Retry actually refetches. */
const cache = new Map<string, Promise<GhlMessageRow[]>>();

function loadMessages(personId: string, force = false): Promise<GhlMessageRow[]> {
  if (force) cache.delete(personId);
  let p = cache.get(personId);
  if (!p) {
    const request: Promise<GhlMessageRow[]> = fetch(`/api/people/${personId}/ghl-activity`)
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data: { messages: GhlMessageRow[] }) => data.messages);
    request.catch(() => {
      if (cache.get(personId) === request) cache.delete(personId);
    });
    cache.set(personId, request);
    p = request;
  }
  return p;
}

export interface GhlMessagesState {
  messages: GhlMessageRow[] | null;
  loading: boolean;
  error: boolean;
  retry: () => void;
}

/** Fetches (once, shared) when `enabled` first becomes true. */
export function useGhlMessages(personId: string, enabled: boolean): GhlMessagesState {
  const [messages, setMessages] = useState<GhlMessageRow[] | null>(null);
  const [error, setError] = useState(false);
  // Bumped by Retry; the effect re-runs and forces a fresh request.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!enabled) return;
    let live = true;
    loadMessages(personId, attempt > 0)
      .then((m) => {
        if (!live) return;
        setMessages(m);
        setError(false);
      })
      .catch(() => {
        if (live) setError(true);
      });
    return () => {
      live = false;
    };
  }, [enabled, personId, attempt]);

  const retry = useCallback(() => {
    setError(false);
    setAttempt((n) => n + 1);
  }, []);

  return { messages, loading: enabled && messages === null && !error, error, retry };
}

/* ---------- labels ---------- */

/** GHL's `TYPE_SMS` spelling is machine-facing; show the channel as a person
 * would say it. Unknown types fall back to the raw value minus the prefix. */
export function messageTypeLabel(type: string | null): string {
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

function ChannelIcon({ type, size = 12 }: { type: string | null; size?: number }) {
  const props = { size, className: "shrink-0" };
  switch (type) {
    case "TYPE_EMAIL":
      return <Mail {...props} />;
    case "TYPE_CALL":
      return <Phone {...props} />;
    case "TYPE_VOICEMAIL":
      return <Voicemail {...props} />;
    case "TYPE_SMS":
      return <MessageSquare {...props} />;
    default:
      return <MessageCircle {...props} />;
  }
}

function directionLabel(direction: string | null): string {
  if (direction === "inbound") return "Received";
  if (direction === "outbound") return "Sent";
  return "";
}

function ChannelBadge({ message }: { message: GhlMessageRow }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-rule bg-card px-1.5 py-0.5 text-[11px] font-medium text-ink-soft">
      <ChannelIcon type={message.messageType} size={11} />
      {messageTypeLabel(message.messageType)}
    </span>
  );
}

function dayKey(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  if (dayKey(iso) === dayKey(now.toISOString())) return "Today";
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (dayKey(iso) === dayKey(y.toISOString())) return "Yesterday";
  return d.toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: d.getFullYear() === now.getFullYear() ? undefined : "numeric",
  });
}

function timeOfDay(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}

/* ---------- thread ---------- */

const LONG_BODY_CHARS = 320;
const LONG_BODY_LINES = 6;

function MessageBubble({ message }: { message: GhlMessageRow }) {
  const [expanded, setExpanded] = useState(false);
  const inbound = message.direction === "inbound";
  const outbound = message.direction === "outbound";
  const body = message.body?.trim() ?? "";
  const long = body.length > LONG_BODY_CHARS || body.split("\n").length > LONG_BODY_LINES;

  return (
    <li className={cn("flex flex-col", outbound ? "items-end" : "items-start")}>
      <div
        className={cn(
          "max-w-[88%] min-w-0 rounded-lg border px-3 py-2",
          outbound ? "border-stamp/25 bg-stamp/10" : "border-rule bg-hover",
          !inbound && !outbound && "max-w-full border-dashed bg-transparent"
        )}
      >
        <div className="mb-1 flex flex-wrap items-center gap-1.5">
          <ChannelBadge message={message} />
          {directionLabel(message.direction) && (
            <span className={cn("text-[11px] font-medium", outbound ? "text-stamp" : "text-ink-soft")}>
              {directionLabel(message.direction)}
            </span>
          )}
        </div>
        {body ? (
          <>
            <p
              className={cn(
                "text-sm leading-relaxed whitespace-pre-wrap break-words text-ink",
                long && !expanded && "line-clamp-6"
              )}
            >
              {body}
            </p>
            {long && (
              <button
                type="button"
                onClick={() => setExpanded((v) => !v)}
                aria-expanded={expanded}
                className="mt-1 text-xs font-medium text-stamp underline-offset-2 hover:underline focus-visible:underline"
              >
                {expanded ? "Show less" : "Show more"}
              </button>
            )}
          </>
        ) : (
          <p className="text-sm text-ink-mute italic">No message text</p>
        )}
      </div>
      <p
        className="mt-1 px-1 text-[11px] text-ink-mute tabular-nums"
        title={formatAbsoluteDateTime(message.occurredAt)}
      >
        {timeOfDay(message.occurredAt)} · {ghlTimeAgo(message.occurredAt)}
        {message.clientName ? ` · ${message.clientName}` : ""}
      </p>
    </li>
  );
}

/** Newest first (as served), grouped under date separators. */
function MessageThread({ messages }: { messages: GhlMessageRow[] }) {
  const groups: { key: string; label: string; items: GhlMessageRow[] }[] = [];
  for (const m of messages) {
    const key = dayKey(m.occurredAt);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(m);
    else groups.push({ key, label: dayLabel(m.occurredAt), items: [m] });
  }
  return (
    <div className="flex flex-col gap-5">
      {groups.map((g) => (
        <section key={g.key} aria-label={g.label} className="flex flex-col gap-3">
          <div className="flex items-center gap-3" role="separator">
            <span className="h-px flex-1 bg-rule" />
            <span className="text-xs font-medium text-ink-soft">{g.label}</span>
            <span className="h-px flex-1 bg-rule" />
          </div>
          <ul className="flex flex-col gap-3">
            {g.items.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/* ---------- drawer ---------- */

/** Drawer body; render inside a <Dialog.Root>. */
export function GhlHistoryDrawer({
  personId,
  personName,
  lastActivityAt,
  open,
}: {
  personId: string;
  personName: string | null;
  lastActivityAt: string | null | undefined;
  open: boolean;
}) {
  const { messages, loading, error, retry } = useGhlMessages(personId, open);
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showJump, setShowJump] = useState(false);

  const updateJump = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setShowJump(el.scrollHeight - el.scrollTop - el.clientHeight > 80);
  }, []);

  // Re-check once messages render (and when expanding bodies changes height).
  useEffect(() => {
    const id = requestAnimationFrame(updateJump);
    return () => cancelAnimationFrame(id);
  }, [messages, loading, updateJump]);

  const jumpToBottom = () =>
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });

  return (
    <Dialog.Portal>
      <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
      <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-rule bg-card outline-none data-[state=open]:animate-drawer-in data-[state=closed]:animate-drawer-out">
        <div className="flex items-start justify-between gap-3 border-b border-rule px-5 py-4">
          <div className="min-w-0">
            <Dialog.Title className="truncate text-sm font-semibold text-ink">
              {personName ?? "Person"}
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-xs text-ink-soft">
              Message history
              {lastActivityAt && (
                <>
                  {" "}
                  &middot; last activity{" "}
                  <span title={formatAbsoluteDateTime(lastActivityAt)}>{ghlTimeAgo(lastActivityAt)}</span>
                </>
              )}
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

        <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} onScroll={updateJump} className="h-full overflow-y-auto px-5 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-10 text-ink-soft">
              <Loader2 size={16} className="animate-spin" />
            </div>
          ) : error ? (
            <div className="flex flex-col items-start gap-3 py-2">
              <p className="text-sm text-ink-soft">
                Couldn&apos;t load messages. Check your connection and retry.
              </p>
              <button
                type="button"
                onClick={retry}
                className="inline-flex items-center gap-1.5 rounded-md border border-rule px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-hover"
              >
                <RotateCw size={12} />
                Retry
              </button>
            </div>
          ) : messages && messages.length > 0 ? (
            <MessageThread messages={messages} />
          ) : (
            <p className="text-sm text-ink-soft">
              No messages stored yet. Refresh last activity to pull this contact&apos;s history from GHL.
            </p>
          )}
        </div>
        {showJump && (
          <button
            type="button"
            onClick={jumpToBottom}
            aria-label="Scroll to bottom"
            title="Scroll to bottom"
            className="absolute bottom-4 right-5 inline-flex size-9 items-center justify-center rounded-full border border-rule bg-card text-ink shadow-lg hover:bg-hover"
          >
            <ArrowDown size={16} />
          </button>
        )}
        </div>
      </Dialog.Content>
    </Dialog.Portal>
  );
}

/* ---------- person page card ---------- */

export function LastActivityCard({
  personId,
  personName,
}: {
  personId: string;
  personName: string | null;
}) {
  const [open, setOpen] = useState(false);
  const { messages, loading, error, retry } = useGhlMessages(personId, true);
  const latest = messages?.[0];
  const preview = messages?.slice(0, 3) ?? [];

  // No stored messages: show nothing, mirroring the blank table cell.
  if (messages && messages.length === 0) return null;

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">Last activity</h2>
        {messages && messages.length > 0 && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="text-xs font-medium text-stamp underline-offset-2 hover:underline"
          >
            View full history ({messages.length})
          </button>
        )}
      </div>
      <div className="rounded-lg border border-rule bg-card px-5 py-4">
        {error ? (
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-soft">Couldn&apos;t load messages.</p>
            <button
              type="button"
              onClick={retry}
              className="inline-flex items-center gap-1.5 rounded-md border border-rule px-2.5 py-1.5 text-xs font-medium text-ink hover:bg-hover"
            >
              <RotateCw size={12} />
              Retry
            </button>
          </div>
        ) : !latest ? (
          <div className="flex items-center gap-2 text-sm text-ink-soft">
            <Loader2 size={14} className={cn(loading || !messages ? "animate-spin" : "")} /> Loading messages
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-ink">{formatAbsoluteDateTime(latest.occurredAt)}</span>
              <span className="text-xs text-ink-soft">{ghlTimeAgo(latest.occurredAt)}</span>
              <ChannelBadge message={latest} />
              {directionLabel(latest.direction) && (
                <span className="text-xs text-ink-soft">{directionLabel(latest.direction)}</span>
              )}
            </div>
            <ul className="flex flex-col divide-y divide-rule border-t border-rule">
              {preview.map((m) => (
                <li key={m.id} className="flex items-start gap-2.5 py-2">
                  <span
                    className={cn(
                      "mt-0.5 inline-flex size-5 shrink-0 items-center justify-center rounded-full",
                      m.direction === "outbound" ? "bg-stamp/10 text-stamp" : "bg-hover text-ink-soft"
                    )}
                    title={`${messageTypeLabel(m.messageType)} ${directionLabel(m.direction).toLowerCase()}`}
                  >
                    <ChannelIcon type={m.messageType} size={11} />
                  </span>
                  <p className="min-w-0 flex-1 truncate text-sm text-ink">
                    {m.body?.trim() || <span className="text-ink-mute italic">No message text</span>}
                  </p>
                  <span
                    className="shrink-0 text-xs text-ink-mute tabular-nums"
                    title={formatAbsoluteDateTime(m.occurredAt)}
                  >
                    {ghlTimeAgo(m.occurredAt)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <GhlHistoryDrawer
          personId={personId}
          personName={personName}
          lastActivityAt={latest?.occurredAt}
          open={open}
        />
      </Dialog.Root>
    </section>
  );
}
