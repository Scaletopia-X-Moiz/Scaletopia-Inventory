import { cn } from "@/lib/utils";
import type { TicketStatus } from "@/lib/data/tickets";

const STATUS_LABEL: Record<TicketStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  done: "Done",
};

export function StatusBadge({ status }: { status: TicketStatus }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        status === "open" && "bg-rule/50 text-ink-soft",
        status === "in_progress" && "bg-warning/15 text-warning",
        status === "done" && "bg-success/15 text-success"
      )}
    >
      {STATUS_LABEL[status]}
    </span>
  );
}
