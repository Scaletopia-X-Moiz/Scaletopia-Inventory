"use client";

import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";

interface ReverifyDoneResult {
  total_matched: number;
  verified: number;
  errors: number;
  counts: Record<string, number>;
  creditsRemaining: number | null;
  failed: string[];
}

type SseEvent =
  | {
      type: "progress";
      phase: "resolving" | "verifying" | "done";
      done: number;
      total: number;
      verified: number;
      errors: number;
    }
  | { type: "done"; result: ReverifyDoneResult }
  | { type: "error"; message: string };

type Status = "idle" | "confirming" | "verifying";

/** "Reverify filtered" — runs the configured verifier over every matching
 * field value in the current filtered view via SSE, mirroring PushToClayButton.
 * `noun` is the record label ("people" / "companies"), `endpoint` is the SSE
 * route, and `fieldLabel` ("email" / "phone number") plus `providerName`
 * ("MillionVerifier" / "ClearoutPhone") parameterize the confirmation copy so
 * this one component backs both the email and phone reverify features. Every
 * matching row with a value is reverified; each one costs a provider credit,
 * so a confirmation dialog stands in the way. */
export function ReverifyFilteredButton({
  endpoint,
  paramsStr,
  total,
  noun,
  fieldLabel = "email",
  providerName = "MillionVerifier",
  onDone,
}: {
  endpoint: string;
  paramsStr: string;
  total: number;
  noun: string;
  /** What's being reverified, for the button/dialog copy — "email" (default,
   * preserves existing wording) or "phone number". */
  fieldLabel?: string;
  /** Provider named in the confirmation dialog — "MillionVerifier" (default)
   * or "ClearoutPhone". */
  providerName?: string;
  /** Called after a run that actually changed data, so the parent list (which
   * fetches once and caches by filter params) can refetch — reverify doesn't
   * touch the filter params, so nothing else would trigger that refresh. */
  onDone?: () => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [label, setLabel] = useState<string | null>(null);

  const busy = status === "verifying";

  function handleClick() {
    if (busy) return;
    if (total === 0) {
      showToast(`No ${noun} match the current filters.`, "info");
      return;
    }
    setStatus("confirming");
  }

  function handleCancel() {
    if (busy) return;
    setStatus("idle");
  }

  async function handleConfirm() {
    setStatus("verifying");
    setLabel("Resolving…");

    try {
      const response = await fetch(`${endpoint}?${paramsStr}`, { method: "POST" });
      if (!response.ok || !response.body) {
        const message = (await response.json().catch(() => null))?.error ?? "Reverify failed";
        throw new Error(message);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";

        for (const frame of frames) {
          const line = frame.trim();
          if (!line.startsWith("data: ")) continue;
          handleSseEvent(JSON.parse(line.slice("data: ".length)) as SseEvent);
        }
      }
    } catch (error) {
      showToast((error as Error).message || "Reverify interrupted — try again.", "error");
      console.error("Reverify stream error:", error);
    } finally {
      setLabel(null);
      setStatus("idle");
    }
  }

  function handleSseEvent(event: SseEvent) {
    if (event.type === "progress") {
      setLabel(
        event.phase === "resolving"
          ? "Resolving…"
          : `Verifying ${event.done}/${event.total}…`
      );
      return;
    }

    if (event.type === "error") {
      showToast(event.message, "error");
      return;
    }

    if (event.type === "done") {
      const { verified, errors, counts } = event.result;
      const breakdown = Object.entries(counts)
        .map(([k, v]) => `${v} ${k}`)
        .join(", ");
      if (errors === 0) {
        showToast(
          `Reverified ${verified} ${noun}${breakdown ? ` — ${breakdown}` : ""}.`,
          "success"
        );
      } else if (verified > 0) {
        showToast(`Reverified ${verified}, ${errors} failed.`, "error");
      } else {
        showToast(`All ${errors} reverifications failed. Check the API key/credits.`, "error");
      }
      if (verified > 0) onDone?.();
    }
  }

  // "email" -> "emails", "phone number" -> "phone numbers" — naive pluralization
  // that happens to be correct for both current fieldLabel values.
  const idleLabel = `Reverify ${fieldLabel}s`;
  const buttonLabel = busy && label ? label : idleLabel;

  return (
    <AlertDialog.Root
      open={status === "confirming"}
      onOpenChange={(open) => !open && handleCancel()}
    >
      <button
        onClick={handleClick}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-2 rounded-md border border-rule px-3 py-1.5 text-xs font-medium transition-smooth",
          busy
            ? "cursor-not-allowed opacity-50"
            : "text-ink hover:bg-hover active:bg-hover/75 focus-visible:ring-2 focus-visible:ring-stamp/50"
        )}
        aria-label={idleLabel}
      >
        {busy ? (
          <Loader2 size={14} className="animate-spin" />
        ) : (
          <RefreshCw size={14} />
        )}
        {buttonLabel}
      </button>

      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <AlertDialog.Content className="fixed top-[28%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
          <AlertDialog.Title className="text-sm font-semibold text-ink">
            Reverify {total.toLocaleString("en-US")} {noun}?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
            {total >= 1000 ? (
              <span className="mb-1 block text-xs text-ink-mute">
                This is a large run — confirm your filters.
              </span>
            ) : null}
            Every matching record with {fieldLabel === "email" ? "an" : "a"} {fieldLabel} will be
            reverified through {providerName}. Each one uses{" "}
            <strong className="text-ink">one credit</strong>
            {" "}(rows without {fieldLabel === "email" ? "an" : "a"} {fieldLabel} are skipped).
          </AlertDialog.Description>

          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className="rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink transition-smooth hover:bg-hover focus-visible:ring-2 focus-visible:ring-stamp/50"
              >
                Cancel
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              onClick={handleConfirm}
              className="rounded-md bg-stamp px-3 py-1.5 text-xs font-medium text-white transition-smooth hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stamp/50"
            >
              Reverify {total.toLocaleString("en-US")}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
