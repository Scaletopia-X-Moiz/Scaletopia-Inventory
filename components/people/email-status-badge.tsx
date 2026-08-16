import { Tooltip } from "radix-ui";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<string, string> = {
  // Legacy MillionVerifier vocabulary — kept so historical rows (never
  // migrated, per the Icypeas cutover decision) still render a real label
  // instead of falling back to the raw db value.
  ok: "OK",
  catch_all: "Catch-all",
  invalid: "Invalid",
  unknown: "Unknown",
  disposable: "Disposable",
  // Icypeas confidence-scale vocabulary (see lib/icypeas/verify.ts
  // EMAIL_STATUSES). No catch_all/disposable equivalent exists — Icypeas
  // can't produce either (research doc §5c).
  ultra_sure: "Ultra sure",
  very_sure: "Very sure",
  probable: "Probable",
  undeliverable: "Undeliverable",
  not_found: "Not found",
  // Transient marker written the moment a verification job is submitted,
  // before webhook/poll resolves it.
  verifying: "Verifying…",
};

function formatVerifiedAt(value: string | null): string {
  if (!value) return "Never verified";
  return `Last verified ${new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  })}`;
}

/** Badge for `email_status` (people and companies share the same column
 * vocabulary). A record with an email but no status yet reads as "Not
 * verified" rather than rendering nothing — a blank cell is otherwise
 * indistinguishable from "still loading". Hovering shows the last-verified
 * timestamp so a stale "OK" from months ago is visibly stale. Self-contained
 * Tooltip.Provider so this works wherever it's dropped in (table cell or
 * detail page) without the caller wiring one up. */
export function EmailStatusBadge({
  email,
  status,
  verifiedAt = null,
}: {
  email: string | null;
  status: string | null;
  verifiedAt?: string | null;
}) {
  if (!email) return null;

  const label = status ? (STATUS_LABEL[status] ?? status) : "Not verified";

  return (
    <Tooltip.Provider delayDuration={200}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <span
            className={cn(
              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium",
              status === "ok" && "bg-success/15 text-success",
              status === "catch_all" && "bg-warning/15 text-warning",
              status === "invalid" && "bg-danger/15 text-danger",
              status === "disposable" && "bg-danger/15 text-danger",
              status === "unknown" && "bg-rule/50 text-ink-soft",
              // Icypeas vocabulary.
              (status === "ultra_sure" || status === "very_sure") &&
                "bg-success/15 text-success",
              status === "probable" && "bg-warning/15 text-warning",
              status === "undeliverable" && "bg-danger/15 text-danger",
              status === "not_found" && "bg-rule/50 text-ink-soft",
              status === "verifying" && "animate-pulse bg-rule/50 text-ink-mute",
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
