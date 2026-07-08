"use client";

import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { Loader2, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";
import { runSse } from "@/components/shared/use-sse-run";

interface CleanNamesDoneResult {
  total_matched: number;
  cleaned: number;
  skipped: number;
  errors: number;
  failed: string[];
}

type SseEvent =
  | {
      type: "progress";
      phase: "resolving" | "cleaning" | "done";
      done: number;
      total: number;
      cleaned: number;
      errors: number;
    }
  | { type: "done"; result: CleanNamesDoneResult }
  | { type: "error"; message: string };

type Status = "idle" | "confirming" | "cleaning";

/** "Clean names" — runs every brand-name-less company in the current filtered
 * view through OpenRouter (gemini-2.5-flash-lite) via SSE, mirroring
 * ReverifyFilteredButton/PushToClayButton. Companies that already have a
 * brand_name are skipped, so re-running a filter after a partial failure only
 * retries what's left. */
export function CleanNamesButton({
  paramsStr,
  total,
  onDone,
}: {
  paramsStr: string;
  total: number;
  /** Called after a run that actually wrote data, so the parent list (which
   * fetches once and caches by filter params) can refetch. */
  onDone?: () => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [label, setLabel] = useState<string | null>(null);
  const [progress, setProgress] = useState(0); // 0..1, for the fill bar

  const busy = status === "cleaning";

  function handleClick() {
    if (busy) return;
    if (total === 0) {
      showToast("No companies match the current filters.", "info");
      return;
    }
    setStatus("confirming");
  }

  function handleCancel() {
    if (busy) return;
    setStatus("idle");
  }

  async function handleConfirm() {
    setStatus("cleaning");
    setLabel("Resolving…");
    setProgress(0);

    try {
      await runSse<SseEvent>(
        `/api/companies/clean-names?${paramsStr}`,
        { method: "POST" },
        handleSseEvent
      );
    } catch (error) {
      showToast((error as Error).message || "Clean names interrupted — try again.", "error");
      console.error("Clean names stream error:", error);
    } finally {
      setLabel(null);
      setProgress(0);
      setStatus("idle");
    }
  }

  function handleSseEvent(event: SseEvent) {
    if (event.type === "progress") {
      if (event.phase === "resolving") {
        setLabel("Resolving…");
        setProgress(0);
      } else {
        setLabel(`Cleaning ${event.done}/${event.total}…`);
        setProgress(event.total > 0 ? event.done / event.total : 0);
      }
      return;
    }

    if (event.type === "error") {
      showToast(event.message, "error");
      return;
    }

    if (event.type === "done") {
      const { cleaned, skipped, errors } = event.result;
      if (errors === 0) {
        showToast(
          `Cleaned ${cleaned} company name${cleaned === 1 ? "" : "s"}${
            skipped > 0 ? ` (${skipped} already had one)` : ""
          }.`,
          "success"
        );
      } else if (cleaned > 0) {
        showToast(`Cleaned ${cleaned}, ${errors} failed.`, "error");
      } else {
        showToast(`All ${errors} name cleans failed. Check the OpenRouter key/credits.`, "error");
      }
      if (cleaned > 0) onDone?.();
    }
  }

  const idleLabel = "Clean names";
  const buttonLabel = busy && label ? label : idleLabel;

  return (
    <AlertDialog.Root
      open={status === "confirming"}
      onOpenChange={(open) => !open && handleCancel()}
    >
      <div className="flex flex-col items-stretch gap-1">
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
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Sparkles size={14} />}
          {buttonLabel}
        </button>
        {busy ? (
          <div className="h-1 w-full overflow-hidden rounded-full bg-rule">
            <div
              className="h-full rounded-full bg-stamp transition-[width] duration-300 ease-out"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
        ) : null}
      </div>

      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <AlertDialog.Content className="fixed top-[28%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
          <AlertDialog.Title className="text-sm font-semibold text-ink">
            Clean {total.toLocaleString("en-US")} company names?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
            {total >= 1000 ? (
              <span className="mb-1 block text-xs text-ink-mute">
                This is a large run — confirm your filters.
              </span>
            ) : null}
            Every matching company without a brand name yet is run through AI to produce a short,
            simplified brand name. Companies that already have one are skipped.
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
              Clean {total.toLocaleString("en-US")}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
