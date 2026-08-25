import { cn } from "@/lib/utils";
import { PRIORITY_LABEL, type TicketPriority } from "@/lib/tickets/priority";

export function PriorityBadge({ priority }: { priority: TicketPriority }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        priority === "urgent" && "bg-danger/15 text-danger",
        priority === "high" && "bg-warning/15 text-warning",
        priority === "medium" && "bg-rule/50 text-ink-soft",
        priority === "low" && "bg-stamp/15 text-stamp",
        priority === "nice_to_have" && "bg-ink-mute/15 text-ink-mute"
      )}
    >
      {PRIORITY_LABEL[priority]}
    </span>
  );
}
