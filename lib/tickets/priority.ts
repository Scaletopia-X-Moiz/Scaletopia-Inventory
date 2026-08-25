// Ticket priority vocabulary + labels. Deliberately NOT defined in
// lib/data/tickets.ts — that module is `server-only`, but this file is
// bundled into client components (create-ticket-dialog.tsx,
// ticket-detail-drawer.tsx, priority-badge.tsx via tickets-list.tsx) that
// need the option list and labels for <select> menus and badges. Mirrors
// the split used for email status in lib/data/email-status.ts.
export type TicketPriority = "urgent" | "high" | "medium" | "low" | "nice_to_have";

export const PRIORITY_OPTIONS: TicketPriority[] = [
  "urgent",
  "high",
  "medium",
  "low",
  "nice_to_have",
];

export const PRIORITY_LABEL: Record<TicketPriority, string> = {
  urgent: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
  nice_to_have: "Nice to have",
};
