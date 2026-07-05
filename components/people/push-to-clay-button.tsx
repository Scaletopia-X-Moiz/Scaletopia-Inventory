"use client";

import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { Loader2, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";

const WEBHOOK_STORAGE_KEY = "clay-webhook-url-people";

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

function isValidHttps(url: string): boolean {
  try {
    return new URL(url.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

export function PushToClayButton({ paramsStr, total }: { paramsStr: string; total: number }) {
  const [status, setStatus] = useState<Status>("idle");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [pushLabel, setPushLabel] = useState<string | null>(null);

  const busy = status === "pushing";
  const urlValid = isValidHttps(webhookUrl);

  function handleClick() {
    if (busy) return;
    if (total === 0) {
      showToast("No people match the current filters.", "info");
      return;
    }
    // Pre-fill the last URL used on this device for convenience.
    if (typeof window !== "undefined") {
      setWebhookUrl(window.localStorage.getItem(WEBHOOK_STORAGE_KEY) ?? "");
    }
    setStatus("confirming");
  }

  function handleCancel() {
    if (busy) return;
    setStatus("idle");
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
      const response = await fetch(`/api/people/push-to-clay?${paramsStr}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ webhookUrl: url }),
      });

      if (!response.ok || !response.body) {
        const message =
          (await response.json().catch(() => null))?.error ?? "Push failed";
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
          const event: SseEvent = JSON.parse(line.slice("data: ".length));
          handleSseEvent(event);
        }
      }
    } catch (error) {
      showToast((error as Error).message || "Push interrupted — try again.", "error");
      console.error("Push to Clay stream error:", error);
    } finally {
      setPushLabel(null);
      setStatus("idle");
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
        showToast(`Pushed ${pushed} people to Clay.`, "success");
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
            <strong className="text-ink">{total.toLocaleString("en-US")}</strong> people in the
            current view will be pushed. Every matching person is sent, including any pushed
            before.
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
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
