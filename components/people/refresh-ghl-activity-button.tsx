"use client";

import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";
import { fetchActiveClients } from "@/lib/data/active-clients-client";
import { useRegisterDialogOpen } from "@/components/shared/dialog-stack";
import type { ClientOption } from "@/lib/data/clients";

/** "Refresh activity": re-reads GHL last activity for every contact already
 * pushed to the chosen sub-account.
 *
 * Deliberately NOT scoped to the current filters, unlike every other button in
 * this toolbar. The sync's working set is "every contact this client has a
 * GHL contact id for" — scoping it to the view would make the refreshed set
 * depend on which page the user happened to be on, and the result would look
 * arbitrary the moment they changed a filter.
 *
 * Runs as a background push job (platform `ghl_activity`), so progress is
 * polled in the Push Activity panel exactly like a push — the same
 * enqueue-and-toast flow PushToGhlButton uses, rather than a second progress
 * UI that would have to be kept in sync with it. */
export function RefreshGhlActivityButton({ onDone }: { onDone?: () => void }) {
  const [open, setOpen] = useState(false);
  const [clients, setClients] = useState<ClientOption[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useRegisterDialogOpen(open);

  async function handleClick() {
    setOpen(true);
    setError(null);
    if (clients === null) {
      try {
        const active = await fetchActiveClients<ClientOption[]>();
        setClients(active);
      } catch {
        setError("Failed to load clients.");
        setClients([]);
      }
    }
  }

  function reset() {
    setOpen(false);
    setBusy(false);
    setSelectedId(null);
    setFull(false);
    setError(null);
  }

  async function handleConfirm() {
    if (!selectedId) return;
    setBusy(true);
    try {
      const res = await fetch("/api/people/refresh-ghl-activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: selectedId, full }),
      });
      if (!res.ok) {
        const message = (await res.json().catch(() => null))?.error ?? "Failed to start refresh";
        throw new Error(message);
      }
    } catch (err) {
      showToast((err as Error).message || "Failed to queue refresh — try again.", "error");
      setBusy(false);
      return;
    }

    showToast("Activity refresh queued — track it in Push Activity", "success");
    onDone?.();
    reset();
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && reset()}>
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-2 rounded-md border border-rule px-3 py-1.5 text-xs font-medium transition-smooth",
          busy
            ? "cursor-not-allowed opacity-50"
            : "text-ink hover:bg-hover active:bg-hover/75 focus-visible:ring-2 focus-visible:ring-stamp/50"
        )}
        aria-label="Refresh GHL last activity"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        Refresh activity
      </button>

      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <AlertDialog.Content className="fixed top-[24%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
          <AlertDialog.Title className="text-sm font-semibold text-ink">
            Refresh GHL last activity
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
            Re-reads message history for every contact already pushed to the chosen sub-account. Not
            limited to the current filters.
          </AlertDialog.Description>

          <div className="mt-4 flex flex-col gap-3">
            {error && <p className="text-xs text-red-500">{error}</p>}
            {clients === null ? (
              <div className="flex items-center gap-2 text-xs text-ink-soft">
                <Loader2 size={14} className="animate-spin" /> Loading clients…
              </div>
            ) : (
              <select
                value={selectedId ?? ""}
                onChange={(e) => setSelectedId(e.target.value || null)}
                className="rounded-md border border-rule bg-card px-2 py-1.5 text-sm text-ink"
              >
                <option value="">Choose a sub-account…</option>
                {clients.map((client) => (
                  <option key={client.id} value={client.id}>
                    {client.name}
                  </option>
                ))}
              </select>
            )}

            <label className="flex items-start gap-2 text-xs text-ink-soft">
              <input
                type="checkbox"
                checked={full}
                onChange={(e) => setFull(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Full re-read. By default the refresh first sweeps the sub-account&apos;s
                conversations and only re-reads contacts whose activity actually moved — usually a
                couple of API calls instead of one per contact. Tick this to skip that and re-read
                everyone.
              </span>
            </label>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className="rounded-md border border-rule px-3 py-1.5 text-xs text-ink-soft hover:bg-hover"
              >
                Cancel
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!selectedId || busy}
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium",
                !selectedId || busy
                  ? "cursor-not-allowed bg-rule text-ink-mute"
                  : "bg-stamp text-white hover:bg-stamp/90"
              )}
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              Refresh
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
