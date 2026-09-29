"use client";

import { Inbox } from "lucide-react";
import { timeAgo } from "@/lib/utils";
import type { Role } from "@/lib/auth/dal";
import type { TicketRow } from "@/lib/data/tickets";
import { CategoryBadge } from "@/components/tickets/category-badge";
import { PriorityBadge } from "@/components/tickets/priority-badge";
import { StatusBadge } from "@/components/tickets/status-badge";
import { TicketDetailDrawer } from "@/components/tickets/ticket-detail-drawer";

export function TicketsList({
  tickets,
  viewerRole,
  viewerId,
}: {
  tickets: TicketRow[];
  viewerRole: Role;
  viewerId: string;
}) {
  if (tickets.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-rule bg-card px-5 py-14 text-center">
        <Inbox size={22} className="text-ink-mute" />
        <p className="text-sm font-medium text-ink">Nothing here</p>
        <p className="text-xs text-ink-soft">No tickets match this view yet.</p>
      </div>
    );
  }

  return (
    <ul className="flex flex-col gap-2.5">
      {tickets.map((ticket) => (
        <li key={ticket.id}>
          <TicketDetailDrawer ticket={ticket} viewerRole={viewerRole} viewerId={viewerId}>
            <button
              type="button"
              className="group flex w-full flex-col gap-3 rounded-xl border border-rule bg-card px-4 py-3.5 text-left shadow-sm transition-all hover:-translate-y-px hover:border-stamp/40 hover:shadow-md sm:flex-row sm:items-center sm:justify-between sm:gap-4"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold text-ink group-hover:text-stamp">
                  {ticket.title}
                </p>
                <p className="mt-1 truncate text-xs text-ink-soft">
                  <span className="font-mono tabular-nums">#{ticket.id}</span> ·{" "}
                  {ticket.createdByEmail ?? "unknown"} · {timeAgo(ticket.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                <PriorityBadge priority={ticket.priority} />
                <CategoryBadge category={ticket.category} />
                <StatusBadge status={ticket.status} />
              </div>
            </button>
          </TicketDetailDrawer>
        </li>
      ))}
    </ul>
  );
}
