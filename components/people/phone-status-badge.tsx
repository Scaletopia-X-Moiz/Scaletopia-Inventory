import { Tooltip } from "radix-ui";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = {
  valid: "Valid",
  invalid: "Invalid",
};

function formatVerifiedAt(value: string | null): string {
  if (!value) return "Never verified";
  return `Last verified ${new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

/** Badge for `phone_status` (people and companies share the same column
 * vocabulary). A record with a phone but no status yet reads as "Not
 * verified" rather than rendering nothing — a blank cell is otherwise
 * indistinguishable from "still loading". Hovering shows the last-verified
 * timestamp so a stale "Valid" from months ago is visibly stale. Self-contained
 * Tooltip.Provider so this works wherever it's dropped in (table cell or
 * detail page) without the caller wiring one up. Falls back to showing the raw
 * status muted gray for anything outside valid/invalid — ClearoutPhone's
 * status set isn't confirmed closed. */
export function PhoneStatusBadge({
  phone,
  status,
  verifiedAt = null,
}: {
  phone: string | null;
  status: string | null;
  verifiedAt?: string | null;
}) {
  if (!phone) return null;

  const label = status ? (STATUS_LABEL[status] ?? status) : "Not verified";

  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
              status === "valid" && "bg-success/15 text-success",
              status === "invalid" && "bg-danger/15 text-danger",
              status && !STATUS_LABEL[status] && "bg-rule/50 text-ink-soft",
              !status && "bg-rule/50 text-ink-mute"
            )}
          >
            {label}
          </span>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            className="z-50 rounded-md border border-rule bg-popover px-2.5 py-1.5 text-xs text-ink-soft shadow-lg"
          >
            {formatVerifiedAt(verifiedAt)}
            <Tooltip.Arrow className="fill-popover" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
