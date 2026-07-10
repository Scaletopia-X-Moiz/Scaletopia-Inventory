"use client";

import { timeAgo } from "@/lib/utils";
import type { Role } from "@/lib/auth/dal";
import type { TicketRow } from "@/lib/data/tickets";
import { CategoryBadge } from "@/components/tickets/category-badge";
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
      <div className="rounded-xl border border-rule bg-card px-5 py-10 text-center text-sm text-ink-soft">
        No tickets here yet.
      </div>
    );
  }

  return (
    <ul className="flex flex-col overflow-hidden rounded-xl border border-rule bg-card">
      {tickets.map((ticket) => (
        <li key={ticket.id} className="border-b border-rule last:border-0">
          <TicketDetailDrawer ticket={ticket} viewerRole={viewerRole} viewerId={viewerId}>
            <button
              type="button"
              className="flex w-full flex-col gap-1.5 px-4 py-3 text-left transition-colors hover:bg-hover sm:flex-row sm:items-center sm:justify-between sm:gap-3"
            >
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-ink">{ticket.title}</p>
                <p className="mt-0.5 truncate text-xs text-ink-soft">
                  #{ticket.id} · {ticket.createdByEmail ?? "unknown"} · {timeAgo(ticket.createdAt)}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
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
