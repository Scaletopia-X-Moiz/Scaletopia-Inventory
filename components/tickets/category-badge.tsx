import { cn } from "@/lib/utils";
import type { TicketCategory } from "@/lib/data/tickets";

const CATEGORY_LABEL: Record<TicketCategory, string> = {
  bug: "Bug",
  feature_request: "Feature request",
  improvement: "Improvement",
};

export function CategoryBadge({ category }: { category: TicketCategory }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium",
        category === "bug" && "bg-danger/15 text-danger",
        category === "feature_request" && "bg-stamp/15 text-stamp",
        category === "improvement" && "bg-success/15 text-success"
      )}
    >
      {CATEGORY_LABEL[category]}
    </span>
  );
}
