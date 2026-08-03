"use client";

import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { Loader2, Rocket } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";
import { runSse } from "@/components/shared/use-sse-run";
import { useRegisterDialogOpen } from "@/components/shared/dialog-stack";
import type {
  EmailBisonCampaignPushResult,
  EmailBisonCampaignPushProgress,
} from "@/lib/emailbison/push-to-emailbison";
import type { EmailBisonCampaign } from "@/lib/emailbison/client";

interface ActiveClient {
  id: string;
  name: string;
  hasEmailBisonCredentials: boolean;
}

type SseEvent =
  | ({ type: "progress" } & EmailBisonCampaignPushProgress)
  | { type: "done"; action: "campaign"; result: EmailBisonCampaignPushResult; note: string }
  | { type: "error"; message: string };

type Status = "idle" | "open" | "pushing";
type Step = "picker" | "campaign" | "confirm" | "summary";

/** "Add to Campaign", the Companies-table counterpart of
 * push-to-emailbison-campaign-button.tsx (People table, issue #63) — resolves
 * to every Person linked to the currently filtered Companies before enrolling
 * into a live-fetched campaign, mirroring #62's relationship to #61 (ADR
 * 0003, issue #64). Anyone missing a prior EmailBison lead id is silently
 * upserted first (runEmailBisonAddToCampaign, ticket #59). */
export function PushToEmailBisonCampaignButton({
  paramsStr,
  total,
  onDone,
}: {
  paramsStr: string;
  total: number;
  /** Fired once the push stream reaches its `done` event — mirrors
   * PushToEmailBisonButton's onDone. */
  onDone?: () => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [step, setStep] = useState<Step>("picker");
  const [pushLabel, setPushLabel] = useState<string | null>(null);

  const [clients, setClients] = useState<ActiveClient[] | null>(null);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  const [campaigns, setCampaigns] = useState<EmailBisonCampaign[] | null>(null);
  const [campaignsError, setCampaignsError] = useState<string | null>(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [parallel, setParallel] = useState(false);

  const [result, setResult] = useState<EmailBisonCampaignPushResult | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const busy = status === "pushing";
  const selectedClient = clients?.find((c) => c.id === selectedClientId) ?? null;
  const selectedCampaign = campaigns?.find((c) => c.id === selectedCampaignId) ?? null;

  // Registers this dialog (including its persistent "Push complete" summary
  // step) with the shared dialog stack so other prompts — e.g. the post-push
  // "remove temporary columns?" prompt — know not to open on top of it
  // (issue #89).
  useRegisterDialogOpen(status !== "idle");

  function reset() {
    setStatus("idle");
    setStep("picker");
    setPushLabel(null);
    setClients(null);
    setClientsError(null);
    setSelectedClientId(null);
    setCampaigns(null);
    setCampaignsError(null);
    setSelectedCampaignId(null);
    setParallel(false);
    setResult(null);
    setNote(null);
  }

  async function handleClick() {
    if (busy) return;
    if (total === 0) {
      showToast("No companies match the current filters.", "info");
      return;
    }
    setStep("picker");
    setStatus("open");
    setClients(null);
    setClientsError(null);
    setSelectedClientId(null);

    try {
      const res = await fetch("/api/clients/active");
      if (!res.ok) throw new Error("Failed to load clients");
      const data = (await res.json()) as { clients: ActiveClient[] };
      setClients(data.clients);
    } catch (error) {
      setClientsError((error as Error).message || "Failed to load clients.");
    }
  }

  function handleCancel() {
    if (busy) return;
    reset();
  }

  async function handleContinueFromPicker() {
    if (!selectedClient || !selectedClient.hasEmailBisonCredentials) return;

    setStep("campaign");
    setCampaigns(null);
    setCampaignsError(null);
    setSelectedCampaignId(null);

    try {
      const res = await fetch(`/api/clients/${selectedClient.id}/emailbison-campaigns`);
      if (!res.ok) throw new Error("Failed to load campaigns");
      const data = (await res.json()) as { campaigns: EmailBisonCampaign[] };
      setCampaigns(data.campaigns);
    } catch (error) {
      setCampaignsError((error as Error).message || "Failed to load campaigns.");
    }
  }

  function handleConfirmCampaign() {
    if (!selectedCampaign) return;
    setStep("confirm");
  }

  async function handleConfirm() {
    if (!selectedClient || !selectedCampaign) return;

    setStatus("pushing");
    setPushLabel("Pushing…");
    let reachedDone = false;

    try {
      await runSse<SseEvent>(
        `/api/emailbison/push?${paramsStr}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entity: "companies",
            action: "campaign",
            clientId: selectedClient.id,
            campaignId: selectedCampaign.id,
            parallel,
          }),
        },
        (event) => {
          if (event.type === "done") reachedDone = true;
          handleSseEvent(event);
        }
      );
    } catch (error) {
      showToast((error as Error).message || "Push interrupted — try again.", "error");
      console.error("Add to Campaign stream error:", error);
      reset();
      return;
    }

    // A terminal `{type: "error"}` frame (e.g. missing EmailBison credentials)
    // closes the stream without ever sending `done` — treat that as a failed
    // run and close the dialog rather than leaving it stuck mid-"pushing".
    if (!reachedDone) {
      reset();
      return;
    }

    setPushLabel(null);
  }

  function handleSseEvent(event: SseEvent) {
    if (event.type === "progress") {
      const phaseLabel =
        event.phase === "resolving"
          ? "Resolving…"
          : event.phase === "adding-to-workspace"
            ? `Adding to workspace ${event.done}/${event.total}…`
            : event.phase === "attaching"
              ? `Attaching ${event.done}/${event.total}…`
              : null;
      if (phaseLabel) setPushLabel(phaseLabel);
      return;
    }

    if (event.type === "error") {
      showToast(event.message, "error");
      return;
    }

    if (event.type === "done") {
      setResult(event.result);
      setNote(event.note);
      setStatus("open");
      setStep("summary");
      onDone?.();
    }
  }

  const label = status === "pushing" && pushLabel ? pushLabel : "Add to EmailBison Campaign";

  return (
    <AlertDialog.Root open={status !== "idle"} onOpenChange={(open) => !open && handleCancel()}>
      <button
        onClick={handleClick}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-2 rounded-md border border-rule px-3 py-1.5 text-xs font-medium transition-smooth",
          busy
            ? "opacity-50 cursor-not-allowed"
            : "text-ink hover:bg-hover active:bg-hover/75 focus-visible:ring-2 focus-visible:ring-stamp/50"
        )}
        aria-label="Add to EmailBison Campaign"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
        {label}
      </button>

      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />

        {step === "picker" ? (
          <AlertDialog.Content className="fixed top-[24%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Add to Campaign — choose a client
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              Select which client&apos;s EmailBison workspace owns the campaign that will receive
              every person linked to the{" "}
              <strong className="text-ink">{total.toLocaleString("en-US")}</strong> companies in
              the current view.
            </AlertDialog.Description>

            <div className="mt-4 flex max-h-64 flex-col gap-1 overflow-y-auto">
              {clientsError ? (
                <p className="text-xs text-danger">{clientsError}</p>
              ) : clients === null ? (
                <p className="flex items-center gap-2 text-xs text-ink-soft">
                  <Loader2 size={12} className="animate-spin" />
                  Loading clients…
                </p>
              ) : clients.length === 0 ? (
                <p className="text-xs text-ink-soft">No active clients found.</p>
              ) : (
                clients.map((client) => (
                  <label
                    key={client.id}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-md border border-rule px-3 py-2 text-xs",
                      client.hasEmailBisonCredentials ? "cursor-pointer hover:bg-hover" : "opacity-50"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="emailbison-campaign-client"
                        value={client.id}
                        checked={selectedClientId === client.id}
                        disabled={!client.hasEmailBisonCredentials}
                        onChange={() => setSelectedClientId(client.id)}
                      />
                      <span className="font-medium text-ink">{client.name}</span>
                    </span>
                    {!client.hasEmailBisonCredentials ? (
                      <span className="text-ink-mute">No EmailBison credentials</span>
                    ) : null}
                  </label>
                ))
              )}
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
                onClick={handleContinueFromPicker}
                disabled={!selectedClient?.hasEmailBisonCredentials}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                  selectedClient?.hasEmailBisonCredentials
                    ? "bg-stamp hover:opacity-90"
                    : "bg-stamp/40 cursor-not-allowed"
                )}
              >
                Continue →
              </button>
            </div>
          </AlertDialog.Content>
        ) : step === "campaign" ? (
          <AlertDialog.Content className="fixed top-[20%] left-1/2 z-50 w-full max-w-lg -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Campaign &amp; run settings
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <div className="mt-4 flex flex-col gap-5 text-sm text-ink-soft">
                <div>
                  <p className="text-xs font-medium text-ink">Campaign</p>
                  <p className="mt-1 text-xs text-ink-mute">
                    Live-fetched from {selectedClient?.name}&apos;s EmailBison workspace.
                  </p>
                  <div className="mt-2">
                    {campaignsError ? (
                      <p className="text-xs text-danger">{campaignsError}</p>
                    ) : campaigns === null ? (
                      <p className="flex items-center gap-2 text-xs text-ink-soft">
                        <Loader2 size={12} className="animate-spin" />
                        Loading campaigns…
                      </p>
                    ) : campaigns.length === 0 ? (
                      <p className="text-xs text-ink-mute">No campaigns in this workspace yet.</p>
                    ) : (
                      <select
                        value={selectedCampaignId ?? ""}
                        onChange={(e) => setSelectedCampaignId(e.target.value || null)}
                        className="w-full rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                      >
                        <option value="">Select a campaign…</option>
                        {campaigns.map((campaign) => (
                          <option key={campaign.id} value={campaign.id}>
                            {campaign.name}
                          </option>
                        ))}
                      </select>
                    )}
                  </div>
                </div>

                <div>
                  <label className="flex items-center justify-between gap-3">
                    <span>
                      <span className="text-xs font-medium text-ink">Allow parallel sending</span>
                      <span className="mt-0.5 block text-xs text-ink-mute">
                        Off sends this campaign&apos;s leads sequentially (default); on lets
                        EmailBison send in parallel.
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={parallel}
                      onChange={(e) => setParallel(e.target.checked)}
                      className="shrink-0"
                    />
                  </label>
                </div>
              </div>
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
                onClick={handleConfirmCampaign}
                disabled={!selectedCampaign}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                  selectedCampaign ? "bg-stamp hover:opacity-90" : "bg-stamp/40 cursor-not-allowed"
                )}
              >
                Continue →
              </button>
            </div>
          </AlertDialog.Content>
        ) : step === "confirm" ? (
          <AlertDialog.Content className="fixed top-[26%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Add to {selectedCampaign?.name}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              Every person linked to the{" "}
              <strong className="text-ink">{total.toLocaleString("en-US")}</strong> companies in
              the current view will be queued for this campaign on {selectedClient?.name}&apos;s
              EmailBison workspace. Anyone not already an EmailBison lead is added first,
              automatically. A company with no linked people contributes nothing and won&apos;t
              error. No quality filter is applied.
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
                Push
              </button>
            </div>
          </AlertDialog.Content>
        ) : (
          <AlertDialog.Content className="fixed top-[26%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Push complete
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <div className="mt-2 text-sm text-ink-soft">
                {result ? (
                  <ul className="flex flex-col gap-1">
                    <li>
                      Queued for campaign: <strong className="text-ink">{result.attached}</strong>
                    </li>
                    <li>
                      Failed: <strong className="text-ink">{result.errors}</strong>
                    </li>
                    {result.failed.length > 0 ? (
                      <li className="mt-1 flex flex-col gap-0.5 text-xs text-ink-mute">
                        {result.failed.slice(0, 5).map((f, i) => (
                          <span key={i}>
                            Failed: {f.name} — {f.reason}
                          </span>
                        ))}
                        {result.failed.length > 5 ? (
                          <span>…and {result.failed.length - 5} more</span>
                        ) : null}
                      </li>
                    ) : null}
                    {note ? <li className="mt-2 text-xs text-ink-mute">{note}</li> : null}
                  </ul>
                ) : null}
              </div>
            </AlertDialog.Description>

            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  onClick={reset}
                  className="rounded-md bg-stamp px-3 py-1.5 text-xs font-medium text-white transition-smooth hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stamp/50"
                >
                  Close
                </button>
              </AlertDialog.Cancel>
            </div>
          </AlertDialog.Content>
        )}
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
