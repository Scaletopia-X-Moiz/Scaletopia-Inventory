import Link from "next/link";
import { cn } from "@/lib/utils";
import type { TicketTab } from "@/lib/data/tickets";

const TABS: { id: TicketTab; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "done", label: "Done" },
  { id: "all", label: "All" },
];

export function TicketTabs({ active }: { active: TicketTab }) {
  return (
    <div className="flex items-center gap-1.5" role="tablist">
      {TABS.map((tab) => (
        <Link
          key={tab.id}
          href={tab.id === "open" ? "/tickets" : `/tickets?tab=${tab.id}`}
          role="tab"
          aria-selected={active === tab.id}
          className={cn(
            "rounded-full px-3 py-1.5 text-sm font-medium transition-colors",
            active === tab.id
              ? "bg-stamp text-white"
              : "text-ink-soft hover:bg-hover hover:text-ink"
          )}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
