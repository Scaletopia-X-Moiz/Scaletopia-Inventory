"use client";

import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { Loader2, Send, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";
import { runSse } from "@/components/shared/use-sse-run";

const WEBHOOK_STORAGE_KEY = "clay-webhook-url";

type PushDoneResult = {
  total_matched: number;
  pushed: number;
  errors: number;
  failed_companies: string[];
};

type SseEvent =
  | { type: "progress"; phase: "resolving" | "pushing" | "done"; done: number; total: number; pushed: number; errors: number }
  | { type: "done"; result: PushDoneResult }
  | { type: "error"; message: string };

type Status = "idle" | "confirming" | "pushing";
type Step = "checklist" | "webhook";

function isValidHttps(url: string): boolean {
  try {
    return new URL(url.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// "Before you push" checklist — a non-blocking first screen offering to run
// the reverify/clean-names bulk actions inline before continuing to the
// webhook step. Each row drives the SSE endpoint directly via useSseRun
// rather than reusing ReverifyFilteredButton/CleanNamesButton, since those
// each own their own AlertDialog and nesting Radix dialogs breaks focus/
// portal behavior.
// ---------------------------------------------------------------------------

type RunState = "idle" | "running" | "done";

interface ChecklistDoneResult {
  total_matched: number;
  // Reverify results call this "verified"; clean-names calls it "cleaned".
  // Both are read defensively below.
  verified?: number;
  cleaned?: number;
  errors: number;
}

type ChecklistSseEvent =
  | { type: "progress"; phase: string; done: number; total: number }
  | { type: "done"; result: ChecklistDoneResult }
  | { type: "error"; message: string };

function ChecklistRunRow({
  endpoint,
  label,
  paramsStr,
}: {
  endpoint: string;
  label: string;
  paramsStr: string;
}) {
  const [state, setState] = useState<RunState>("idle");
  const [progressLabel, setProgressLabel] = useState<string | null>(null);

  async function handleRun() {
    if (state === "running") return;
    setState("running");
    setProgressLabel("Resolving…");

    try {
      await runSse<ChecklistSseEvent>(`${endpoint}?${paramsStr}`, { method: "POST" }, (event) => {
        if (event.type === "progress") {
          setProgressLabel(
            event.phase === "resolving" ? "Resolving…" : `${event.done}/${event.total}…`
          );
          return;
        }
        if (event.type === "error") {
          showToast(event.message, "error");
          return;
        }
        if (event.type === "done") {
          const done = event.result.verified ?? event.result.cleaned ?? 0;
          const { errors } = event.result;
          if (errors === 0) {
            showToast(`${label}: done (${done}).`, "success");
          } else if (done > 0) {
            showToast(`${label}: ${done} done, ${errors} failed.`, "error");
          } else {
            showToast(`${label}: all ${errors} failed.`, "error");
          }
        }
      });
    } catch (error) {
      showToast((error as Error).message || `${label} interrupted — try again.`, "error");
      console.error(`${label} stream error:`, error);
    } finally {
      setProgressLabel(null);
      setState("done");
    }
  }

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-rule px-3 py-2">
      <span className="text-xs font-medium text-ink">{label}</span>
      <button
        type="button"
        onClick={handleRun}
        disabled={state === "running"}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-rule px-2.5 py-1 text-xs font-medium transition-smooth",
          state === "running"
            ? "cursor-not-allowed opacity-60"
            : "text-ink hover:bg-hover focus-visible:ring-2 focus-visible:ring-stamp/50"
        )}
      >
        {state === "running" ? (
          <>
            <Loader2 size={12} className="animate-spin" />
            {progressLabel}
          </>
        ) : state === "done" ? (
          <>
            <Check size={12} />
            Run again
          </>
        ) : (
          "Run"
        )}
      </button>
    </div>
  );
}

export function PushToClayButton({ paramsStr, total }: { paramsStr: string; total: number }) {
  const [status, setStatus] = useState<Status>("idle");
  const [step, setStep] = useState<Step>("checklist");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [pushLabel, setPushLabel] = useState<string | null>(null);

  const busy = status === "pushing";
  const urlValid = isValidHttps(webhookUrl);

  function handleClick() {
    if (busy) return;
    if (total === 0) {
      showToast("No companies match the current filters.", "info");
      return;
    }
    // Pre-fill the last URL used on this device for convenience.
    if (typeof window !== "undefined") {
      setWebhookUrl(window.localStorage.getItem(WEBHOOK_STORAGE_KEY) ?? "");
    }
    setStep("checklist");
    setStatus("confirming");
  }

  function handleCancel() {
    if (busy) return;
    setStatus("idle");
    setStep("checklist");
  }

  async function handleConfirm() {
    if (!urlValid) return;
    const url = webhookUrl.trim();
    if (typeof window !== "undefined") {
      window.localStorage.setItem(WEBHOOK_STORAGE_KEY, url);
    }

    setStatus("pushing");
    setPushLabel("Pushing…");

    try {
      await runSse<SseEvent>(
        `/api/companies/push-to-clay?${paramsStr}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ webhookUrl: url }),
        },
        handleSseEvent
      );
    } catch (error) {
      showToast((error as Error).message || "Push interrupted — try again.", "error");
      console.error("Push to Clay stream error:", error);
    } finally {
      setPushLabel(null);
      setStatus("idle");
      setStep("checklist");
    }
  }

  function handleSseEvent(event: SseEvent) {
    if (event.type === "progress") {
      // The resolving phase (fetching the matched rows) reports 0/0 until the
      // set is known — show a distinct label so it doesn't look like it's
      // pushing nothing.
      setPushLabel(
        event.phase === "resolving" ? "Resolving…" : `Pushing ${event.done}/${event.total}…`
      );
      return;
    }

    if (event.type === "error") {
      showToast(event.message, "error");
      return;
    }

    if (event.type === "done") {
      const { pushed, errors, failed_companies } = event.result;
      if (errors === 0) {
        showToast(`Pushed ${pushed} companies to Clay.`, "success");
      } else if (pushed > 0) {
        const names = failed_companies.slice(0, 3).join(", ");
        const more = failed_companies.length > 3 ? "…" : "";
        showToast(`Pushed ${pushed}, ${errors} failed: ${names}${more}.`, "error");
      } else {
        showToast(`All ${errors} pushes failed. Check the webhook URL.`, "error");
      }
    }
  }

  const label = status === "pushing" && pushLabel ? pushLabel : "Push to Clay";

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
            ? "opacity-50 cursor-not-allowed"
            : "text-ink hover:bg-hover active:bg-hover/75 focus-visible:ring-2 focus-visible:ring-stamp/50"
        )}
        aria-label="Push to Clay"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        {label}
      </button>

      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        {step === "checklist" ? (
          <AlertDialog.Content className="fixed top-[24%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Before you push
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              Optional — run these on the current {total.toLocaleString("en-US")} companies
              first. None of these block the push.
            </AlertDialog.Description>

            <div className="mt-4 flex flex-col gap-2">
              <ChecklistRunRow
                endpoint="/api/companies/reverify"
                label="Reverify email"
                paramsStr={paramsStr}
              />
              <ChecklistRunRow
                endpoint="/api/companies/reverify-phone"
                label="Reverify phone"
                paramsStr={paramsStr}
              />
              <ChecklistRunRow
                endpoint="/api/companies/clean-names"
                label="Clean names"
                paramsStr={paramsStr}
              />
            </div>

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
                onClick={() => setStep("webhook")}
                className="rounded-md bg-stamp px-3 py-1.5 text-xs font-medium text-white transition-smooth hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stamp/50"
              >
                Continue to push →
              </button>
            </div>
          </AlertDialog.Content>
        ) : (
          <AlertDialog.Content className="fixed top-[28%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Push to Clay?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              {total >= 1000 ? (
                <span className="mb-1 block text-xs text-ink-mute">
                  This is a large push — confirm your filters.
                </span>
              ) : null}
              <strong className="text-ink">{total.toLocaleString("en-US")}</strong> companies in
              the current view will be pushed. Every matching company is sent, including any
              pushed before.
            </AlertDialog.Description>

            <label className="mt-4 block text-xs font-medium text-ink-soft">
              Clay webhook URL
              <input
                type="url"
                inputMode="url"
                autoFocus
                value={webhookUrl}
                onChange={(e) => setWebhookUrl(e.target.value)}
                placeholder="https://api.clay.com/v3/sources/webhook/…"
                className="mt-1 w-full rounded-md border border-rule bg-transparent px-2.5 py-1.5 text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-stamp/50"
              />
            </label>
            {webhookUrl.trim() !== "" && !urlValid ? (
              <p className="mt-1 text-xs text-danger">Enter a valid https:// URL.</p>
            ) : null}

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
                disabled={!urlValid}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                  urlValid ? "bg-stamp hover:opacity-90" : "bg-stamp/40 cursor-not-allowed"
                )}
              >
                Push {total.toLocaleString("en-US")}
              </button>
            </div>
          </AlertDialog.Content>
        )}
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
