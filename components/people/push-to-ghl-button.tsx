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
import type { GhlFieldMapping, GhlStandardFieldMapping } from "@/lib/ghl/types";
import type { ActiveVirtualColumn } from "@/lib/data/virtual-columns";
import {
  fetchSavedPushFieldMapping,
  savePushFieldMapping,
} from "@/lib/data/push-field-mappings-client";

/** Stored shape for platform "ghl" in push_field_mappings (ticket #114) —
 * the two pieces of mapping state this button collects, read back verbatim
 * as the next push's starting point for the same (clientId, "ghl") pair. */
interface SavedGhlFieldMapping {
  standardFields: GhlStandardFieldMapping;
  customFieldMapping: Record<string, string>;
}

/** Reset baseline for standardFields between pushes — matches
 * resolveDefaultFieldMapping's (ticket #108) "no brand_name in the pushed
 * set" default so state is never in an undefined shape between the picker
 * step and the mapping step's fetch resolving. */
const FALLBACK_STANDARD_FIELDS: GhlStandardFieldMapping = {
  companyName: "company_name",
  firstName: "include",
  lastName: "include",
  email: "include",
  phone: "include",
  city: "include",
  country: "include",
};

const STANDARD_FIELD_ROWS: { key: keyof Omit<GhlStandardFieldMapping, "companyName">; label: string }[] = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "city", label: "City" },
  { key: "country", label: "Country" },
];

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
  /** Active virtual/enrichment columns on the current People view. Offered
   * as data sources in the mapping step (ticket #51) shown between picking a
   * client and confirming the push, where each GHL custom field can be
   * mapped to one of these columns or left empty. */
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
  // ghlFieldId -> chosen virtualColumnKey ("" means "no data source / leave empty").
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [standardFields, setStandardFields] = useState<GhlStandardFieldMapping>(FALLBACK_STANDARD_FIELDS);

  const [preview, setPreview] = useState<PreviewCounts | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [customTagSuffix, setCustomTagSuffix] = useState("");

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
    setStandardFields(FALLBACK_STANDARD_FIELDS);
    setPreview(null);
    setPreviewError(null);
    setCustomTagSuffix("");
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

    setStep("mapping");
    setCustomFields(null);
    setCustomFieldsError(null);
    setMapping({});
    setStandardFields(FALLBACK_STANDARD_FIELDS);

    try {
      const res = await fetch(`/api/people/push-to-ghl/default-mapping?${paramsStr}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientId: selectedClient.id, virtualColumns }),
      });
      if (!res.ok) throw new Error("Failed to load field mapping");
      const data = (await res.json()) as {
        customFields: GhlCustomField[];
        standardFields: GhlStandardFieldMapping;
        customFieldMapping: GhlFieldMapping[];
      };
      setCustomFields(data.customFields);
      setStandardFields(data.standardFields);
      setMapping(
        Object.fromEntries(data.customFieldMapping.map((m) => [m.ghlFieldId, m.virtualColumnKey]))
      );

      // Ticket #114: a saved mapping for this (client, "ghl") pair — if one
      // exists — overrides the pure auto-mapping default just applied above.
      // Best-effort: a fetch failure just leaves the auto-mapping default in
      // place, same as having no saved mapping at all.
      try {
        const saved = await fetchSavedPushFieldMapping<SavedGhlFieldMapping>(selectedClient.id, "ghl");
        if (saved) {
          setStandardFields(saved.standardFields);
          setMapping(saved.customFieldMapping);
        }
      } catch {
        // keep auto-mapping default
      }
    } catch (error) {
      setCustomFieldsError((error as Error).message || "Failed to load field mapping.");
    }
  }

  function handleMappingChange(ghlFieldId: string, virtualColumnKey: string) {
    setMapping((prev) => ({ ...prev, [ghlFieldId]: virtualColumnKey }));
  }

  function handleStandardFieldChange<K extends keyof GhlStandardFieldMapping>(
    key: K,
    value: GhlStandardFieldMapping[K]
  ) {
    setStandardFields((prev) => ({ ...prev, [key]: value }));
  }

  async function handleConfirm() {
    if (!selectedClient) return;

    setStatus("pushing");
    setPushLabel("Pushing…");
    let reachedDone = false;

    const fieldMapping: GhlFieldMapping[] = Object.entries(mapping)
      .filter(([, virtualColumnKey]) => virtualColumnKey !== "")
      .map(([ghlFieldId, virtualColumnKey]) => ({ virtualColumnKey, ghlFieldId }));

    // Ticket #114: save the mapping actually being used as the new starting
    // point for the next push to this (client, "ghl") pair. Fire-and-forget —
    // never blocks or fails the push itself; only ever affects future pushes.
    savePushFieldMapping(selectedClient.id, "ghl", {
      standardFields,
      customFieldMapping: mapping,
    } satisfies SavedGhlFieldMapping).catch(() => {});

    try {
      await runSse<SseEvent>(
        `/api/people/push-to-ghl?${paramsStr}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clientId: selectedClient.id,
            fieldMapping,
            standardFieldMapping: standardFields,
            customTagSuffix: customTagSuffix.trim() || undefined,
          }),
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
          <AlertDialog.Content className="fixed top-[20%] left-1/2 z-50 w-full max-w-lg -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Map fields for GHL
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              Review where each field is sourced from before pushing — defaults are pre-selected,
              override any row or skip a field to leave it out of this push.
            </AlertDialog.Description>

            <div className="mt-4 max-h-80 overflow-y-auto rounded-lg border border-rule">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-rule bg-hover">
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-ink-soft">Field</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-ink-soft">Source</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-rule">
                  {customFieldsError ? (
                    <tr>
                      <td colSpan={2} className="px-4 py-2.5 text-xs text-danger">
                        {customFieldsError}
                      </td>
                    </tr>
                  ) : customFields === null ? (
                    <tr>
                      <td colSpan={2} className="px-4 py-2.5">
                        <span className="flex items-center gap-2 text-xs text-ink-soft">
                          <Loader2 size={12} className="animate-spin" />
                          Loading field mapping…
                        </span>
                      </td>
                    </tr>
                  ) : (
                    <>
                      <tr className="bg-paper">
                        <td className="px-4 py-2.5 text-xs font-medium text-ink">Company name</td>
                        <td className="px-4 py-2.5">
                          <select
                            value={standardFields.companyName}
                            onChange={(e) =>
                              handleStandardFieldChange(
                                "companyName",
                                e.target.value as GhlStandardFieldMapping["companyName"]
                              )
                            }
                            className="w-full rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                          >
                            <option value="brand_name">Cleaned brand name</option>
                            <option value="company_name">Raw company name</option>
                            <option value="skip">Skip</option>
                          </select>
                        </td>
                      </tr>
                      {STANDARD_FIELD_ROWS.map((row) => (
                        <tr key={row.key} className="bg-paper">
                          <td className="px-4 py-2.5 text-xs font-medium text-ink">{row.label}</td>
                          <td className="px-4 py-2.5">
                            <select
                              value={standardFields[row.key]}
                              onChange={(e) =>
                                handleStandardFieldChange(
                                  row.key,
                                  e.target.value as "include" | "skip"
                                )
                              }
                              className="w-full rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                            >
                              <option value="include">Include</option>
                              <option value="skip">Skip</option>
                            </select>
                          </td>
                        </tr>
                      ))}
                      {customFields.map((field) => (
                        <tr key={field.id} className="bg-paper">
                          <td className="px-4 py-2.5 text-xs font-medium text-ink">{field.name}</td>
                          <td className="px-4 py-2.5">
                            <select
                              value={mapping[field.id] ?? ""}
                              onChange={(e) => handleMappingChange(field.id, e.target.value)}
                              className="w-full rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                            >
                              <option value="">No data</option>
                              {virtualColumns.map((col) => (
                                <option key={col.key} value={col.key}>
                                  {col.key}
                                </option>
                              ))}
                            </select>
                          </td>
                        </tr>
                      ))}
                    </>
                  )}
                </tbody>
              </table>
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

            <div className="mt-4 flex flex-col gap-1.5">
              <label htmlFor="ghl-tag-suffix" className="text-xs font-medium text-ink">
                Additional tag identifier (optional)
              </label>
              <input
                id="ghl-tag-suffix"
                type="text"
                value={customTagSuffix}
                onChange={(e) => setCustomTagSuffix(e.target.value)}
                placeholder="e.g. leadership, marketing, a segment name"
                className="rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink outline-none focus:border-stamp"
              />
              <p className="text-xs text-ink-mute">
                Tag format: {selectedClient?.name ?? "Client"} - Niche | Employee Range | Country
                | Source
                {customTagSuffix.trim() ? (
                  <>
                    {" | "}
                    <span className="text-ink">{customTagSuffix.trim()}</span>
                  </>
                ) : (
                  <> — your addition goes here as one more segment</>
                )}
              </p>
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
