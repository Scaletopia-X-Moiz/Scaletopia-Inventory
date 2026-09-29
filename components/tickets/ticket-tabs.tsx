import Link from "next/link";
import { cn } from "@/lib/utils";
import type { TicketTab } from "@/lib/data/tickets";

const TABS: { id: TicketTab; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "in_progress", label: "In progress" },
  { id: "testing", label: "Testing" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
];

export function TicketTabs({
  active,
  counts,
}: {
  active: TicketTab;
  counts: Record<TicketTab, number>;
}) {
  return (
    <div
      className="-mx-1 flex items-center gap-1 overflow-x-auto rounded-xl border border-rule bg-card p-1"
      role="tablist"
    >
      {TABS.map((tab) => {
        const isActive = active === tab.id;
        return (
          <Link
            key={tab.id}
            href={tab.id === "open" ? "/tickets" : `/tickets?tab=${tab.id}`}
            role="tab"
            aria-selected={isActive}
            className={cn(
              "flex shrink-0 items-center gap-2 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors",
              isActive
                ? "bg-stamp text-white shadow-sm"
                : "text-ink-soft hover:bg-hover hover:text-ink"
            )}
          >
            {tab.label}
            <span
              className={cn(
                "rounded-full px-1.5 py-px text-[11px] tabular-nums",
                isActive ? "bg-white/20 text-white" : "bg-rule/60 text-ink-soft"
              )}
            >
              {counts[tab.id]}
            </span>
          </Link>
        );
      })}
    </div>
  );
}
