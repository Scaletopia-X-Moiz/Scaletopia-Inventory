"use client";

import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { Loader2, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";
import { runSse } from "@/components/shared/use-sse-run";
import { fetchActiveClients } from "@/lib/data/active-clients-client";
import { useRegisterDialogOpen } from "@/components/shared/dialog-stack";
import type { GhlPushResult } from "@/lib/ghl/push-to-ghl";
import type { GhlCustomField } from "@/lib/ghl/custom-fields";
import type { GhlFieldMapping } from "@/lib/ghl/types";
import type { ActiveVirtualColumn } from "@/lib/data/virtual-columns";

interface ActiveClient {
  id: string;
  name: string;
  hasGhlCredentials: boolean;
}

interface PreviewCounts {
  total_matched: number;
  eligible: number;
  skipped: number;
}

type SseEvent =
  | { type: "progress"; phase: "resolving" | "pushing" | "done"; done: number; total: number; pushed: number; errors: number }
  | { type: "done"; result: GhlPushResult }
  | { type: "error"; message: string };

type Status = "idle" | "open" | "pushing";
type Step = "picker" | "mapping" | "confirm" | "summary";

export function PushToGhlButton({
  paramsStr,
  total,
  virtualColumns = [],
  onDone,
}: {
  paramsStr: string;
  total: number;
  /** Active virtual/enrichment columns on the current People view. When
   * non-empty, a mapping step (ticket #51) is inserted between picking a
   * client and confirming the push, letting each column be mapped to a GHL
   * custom field or skipped. */
  virtualColumns?: ActiveVirtualColumn[];
  /** Fired once the push stream reaches its `done` event — mirrors
   * PushToClayButton's onDone, used by the caller to offer removing any
   * active virtual columns. */
  onDone?: () => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [step, setStep] = useState<Step>("picker");
  const [pushLabel, setPushLabel] = useState<string | null>(null);

  const [clients, setClients] = useState<ActiveClient[] | null>(null);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  const [customFields, setCustomFields] = useState<GhlCustomField[] | null>(null);
  const [customFieldsError, setCustomFieldsError] = useState<string | null>(null);
  // virtualColumnKey -> chosen GHL field id ("" means "skip this column").
  const [mapping, setMapping] = useState<Record<string, string>>({});

  const [preview, setPreview] = useState<PreviewCounts | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [result, setResult] = useState<GhlPushResult | null>(null);

  const busy = status === "pushing";
  const selectedClient = clients?.find((c) => c.id === selectedClientId) ?? null;

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
    setCustomFields(null);
    setCustomFieldsError(null);
    setMapping({});
    setPreview(null);
    setPreviewError(null);
    setResult(null);
  }

  async function handleClick() {
    if (busy) return;
    if (total === 0) {
      showToast("No people match the current filters.", "info");
      return;
    }
    setStep("picker");
    setStatus("open");
    setClients(null);
    setClientsError(null);
    setSelectedClientId(null);

    try {
      const data = await fetchActiveClients<{ clients: ActiveClient[] }>();
      setClients(data.clients);
    } catch (error) {
      setClientsError((error as Error).message || "Failed to load clients.");
    }
  }

  function handleCancel() {
    if (busy) return;
    reset();
  }

  async function loadPreview() {
    setStep("confirm");
    setPreview(null);
    setPreviewError(null);

    try {
      const res = await fetch(`/api/people/push-to-ghl/preview?${paramsStr}`);
      if (!res.ok) throw new Error("Failed to load preview counts");
      const data = (await res.json()) as PreviewCounts;
      setPreview(data);
    } catch (error) {
      setPreviewError((error as Error).message || "Failed to load preview counts.");
    }
  }

  async function handleContinueFromPicker() {
    if (!selectedClient || !selectedClient.hasGhlCredentials) return;

    if (virtualColumns.length === 0) {
      await loadPreview();
      return;
    }

    setStep("mapping");
    setCustomFields(null);
    setCustomFieldsError(null);
    setMapping({});

    try {
      const res = await fetch(`/api/clients/${selectedClient.id}/ghl-custom-fields`);
      if (!res.ok) throw new Error("Failed to load GHL custom fields");
      const data = (await res.json()) as { fields: GhlCustomField[] };
      setCustomFields(data.fields);
    } catch (error) {
      setCustomFieldsError((error as Error).message || "Failed to load GHL custom fields.");
    }
  }

  function handleMappingChange(virtualColumnKey: string, ghlFieldId: string) {
    setMapping((prev) => ({ ...prev, [virtualColumnKey]: ghlFieldId }));
  }

  async function handleConfirm() {
    if (!selectedClient) return;

    setStatus("pushing");
    setPushLabel("Pushing…");
    let reachedDone = false;

    const fieldMapping: GhlFieldMapping[] = Object.entries(mapping)
      .filter(([, ghlFieldId]) => ghlFieldId !== "")
      .map(([virtualColumnKey, ghlFieldId]) => ({ virtualColumnKey, ghlFieldId }));

    try {
      await runSse<SseEvent>(
        `/api/people/push-to-ghl?${paramsStr}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ clientId: selectedClient.id, fieldMapping }),
        },
        (event) => {
          if (event.type === "done") reachedDone = true;
          handleSseEvent(event);
        }
      );
    } catch (error) {
      showToast((error as Error).message || "Push interrupted — try again.", "error");
      console.error("Push to GHL stream error:", error);
      reset();
      return;
    }

    // A terminal `{type: "error"}` frame (e.g. missing GHL credentials) closes
    // the stream without ever sending `done` — treat that as a failed run and
    // close the dialog rather than leaving it stuck mid-"pushing".
    if (!reachedDone) {
      reset();
      return;
    }

    setPushLabel(null);
  }

  function handleSseEvent(event: SseEvent) {
    if (event.type === "progress") {
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
      setResult(event.result);
      setStatus("open");
      setStep("summary");
      onDone?.();
    }
  }

  const label = status === "pushing" && pushLabel ? pushLabel : "Push to GHL";

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
        aria-label="Push to GHL"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        {label}
      </button>

      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />

        {step === "picker" ? (
          <AlertDialog.Content className="fixed top-[24%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Push to GHL — choose a client
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              Select which client&apos;s GHL location will receive the{" "}
              <strong className="text-ink">{total.toLocaleString("en-US")}</strong> people in the
              current view.
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
                      client.hasGhlCredentials ? "cursor-pointer hover:bg-hover" : "opacity-50"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="ghl-client"
                        value={client.id}
                        checked={selectedClientId === client.id}
                        disabled={!client.hasGhlCredentials}
                        onChange={() => setSelectedClientId(client.id)}
                      />
                      <span className="font-medium text-ink">{client.name}</span>
                    </span>
                    {!client.hasGhlCredentials ? (
                      <span className="text-ink-mute">No GHL credentials</span>
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
                disabled={!selectedClient?.hasGhlCredentials}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                  selectedClient?.hasGhlCredentials
                    ? "bg-stamp hover:opacity-90"
                    : "bg-stamp/40 cursor-not-allowed"
                )}
              >
                Continue →
              </button>
            </div>
          </AlertDialog.Content>
        ) : step === "mapping" ? (
          <AlertDialog.Content className="fixed top-[24%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Map enrichment columns to GHL fields
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              Choose a GHL custom field for each active enrichment column, or skip it. Skipped
              columns aren&apos;t sent with the push.
            </AlertDialog.Description>

            <div className="mt-4 flex max-h-64 flex-col gap-2 overflow-y-auto">
              {customFieldsError ? (
                <p className="text-xs text-danger">{customFieldsError}</p>
              ) : customFields === null ? (
                <p className="flex items-center gap-2 text-xs text-ink-soft">
                  <Loader2 size={12} className="animate-spin" />
                  Loading GHL custom fields…
                </p>
              ) : (
                virtualColumns.map((col) => (
                  <label key={col.key} className="flex items-center justify-between gap-3 text-xs">
                    <span className="font-medium text-ink">{col.key}</span>
                    <select
                      value={mapping[col.key] ?? ""}
                      onChange={(e) => handleMappingChange(col.key, e.target.value)}
                      className="rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                    >
                      <option value="">Skip</option>
                      {customFields.map((field) => (
                        <option key={field.id} value={field.id}>
                          {field.name}
                        </option>
                      ))}
                    </select>
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
                onClick={loadPreview}
                disabled={customFields === null}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                  customFields !== null ? "bg-stamp hover:opacity-90" : "bg-stamp/40 cursor-not-allowed"
                )}
              >
                Continue →
              </button>
            </div>
          </AlertDialog.Content>
        ) : step === "confirm" ? (
          <AlertDialog.Content className="fixed top-[26%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Push to {selectedClient?.name}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              {previewError ? (
                <span className="text-danger">{previewError}</span>
              ) : preview === null ? (
                <span className="flex items-center gap-2">
                  <Loader2 size={12} className="animate-spin" />
                  Resolving eligible people…
                </span>
              ) : (
                <>
                  <strong className="text-ink">{preview.eligible.toLocaleString("en-US")}</strong>{" "}
                  of {preview.total_matched.toLocaleString("en-US")} people are eligible (mobile
                  or toll-free phone) and will be pushed.{" "}
                  {preview.skipped > 0 ? (
                    <span className="text-ink-mute">
                      {preview.skipped.toLocaleString("en-US")} will be skipped (landline or
                      missing/unverified phone).
                    </span>
                  ) : null}
                </>
              )}
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
                disabled={preview === null || preview.eligible === 0}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                  preview !== null && preview.eligible > 0
                    ? "bg-stamp hover:opacity-90"
                    : "bg-stamp/40 cursor-not-allowed"
                )}
              >
                Push {preview ? preview.eligible.toLocaleString("en-US") : ""}
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
                      Created: <strong className="text-ink">{result.created}</strong>
                    </li>
                    <li>
                      Tag appended (already in GHL):{" "}
                      <strong className="text-ink">{result.tagAppended}</strong>
                    </li>
                    <li>
                      Failed: <strong className="text-ink">{result.errors}</strong>
                    </li>
                    <li>
                      Skipped (landline/other): <strong className="text-ink">{result.skipped}</strong>
                    </li>
                    {result.failed_people.length > 0 ? (
                      <li className="mt-1 text-xs text-ink-mute">
                        Failed: {result.failed_people.slice(0, 5).join(", ")}
                        {result.failed_people.length > 5 ? "…" : ""}
                      </li>
                    ) : null}
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
