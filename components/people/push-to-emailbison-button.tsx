"use client";

import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { Loader2, Send, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";
import { fetchActiveClients } from "@/lib/data/active-clients-client";
import { useRegisterDialogOpen } from "@/components/shared/dialog-stack";
import type { EmailBisonCustomVariableEntry, EmailBisonStandardFieldMapping } from "@/lib/emailbison/types";
import type { EmailBisonCustomVariable } from "@/lib/emailbison/client";
import type { ActiveVirtualColumn } from "@/lib/data/virtual-columns";
import type { EnrichmentField } from "@/lib/data/enrichment-fields";
import { StandardFieldMappingTable } from "@/components/emailbison/standard-field-mapping-table";
import { normalizeFieldSource } from "@/lib/emailbison/lead-payload";
import {
  fetchSavedPushFieldMapping,
  savePushFieldMapping,
} from "@/lib/data/push-field-mappings-client";

/** Stored shape for platform "emailbison_people" in push_field_mappings
 * (ticket #114) — distinct from "emailbison_companies" since the two
 * entities map an entirely different field set despite sharing
 * EmailBisonStandardFieldMapping's shape. */
interface SavedEmailBisonFieldMapping {
  standardFields: EmailBisonStandardFieldMapping;
}

interface ActiveClient {
  id: string;
  name: string;
  hasEmailBisonCredentials: boolean;
}

type Status = "idle" | "open" | "pushing";
type Step = "picker" | "options" | "confirm";

/** A People-table column bindable by a custom-variable row — the seven
 * standard fields the EmailBison lead payload already carries
 * (lib/emailbison/lead-payload.ts's KNOWN_RECORD_FIELDS). Enrichment/virtual
 * columns are offered separately, from the `virtualColumns` prop. */
const BINDABLE_RECORD_COLUMNS: { key: string; label: string }[] = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "companyName", label: "Company name (raw)" },
  { key: "brandName", label: "Cleaned brand name" },
  { key: "title", label: "Title" },
  { key: "website", label: "Website (domain)" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "country", label: "Country" },
  { key: "fullName", label: "Full name" },
  { key: "linkedinUrl", label: "LinkedIn URL" },
  { key: "linkedinUsername", label: "LinkedIn username" },
  { key: "phoneType", label: "Phone type" },
  { key: "phoneStatus", label: "Phone status" },
  { key: "emailStatus", label: "Email status" },
  { key: "sourceId", label: "Source" },
];

/** Standard-field keys, in the same order the mapping table renders them —
 * used only to normalize a saved mapping field-by-field on load (below), not
 * as a source of truth for the table itself (that's
 * StandardFieldMappingTable's own STANDARD_FIELD_ROWS). */
const STANDARD_FIELD_KEYS: (keyof EmailBisonStandardFieldMapping)[] = [
  "companyName",
  "firstName",
  "lastName",
  "email",
  "phone",
  "title",
  "website",
];

/** A saved mapping (ticket #114) may still be shaped like the pre-free-source
 * include/skip + 3-way companyName enum — normalize every field through
 * normalizeFieldSource so an old saved mapping renders correctly in the new
 * dropdown-per-field table instead of showing a stale/invalid option. */
function normalizeSavedMapping(mapping: EmailBisonStandardFieldMapping): EmailBisonStandardFieldMapping {
  const result = {} as EmailBisonStandardFieldMapping;
  for (const key of STANDARD_FIELD_KEYS) {
    result[key] = normalizeFieldSource(key, mapping[key]);
  }
  return result;
}

interface CustomVariableRow {
  id: number;
  name: string;
  source: "literal" | "column";
  value: string;
  columnKey: string;
}

let rowIdCounter = 0;
function newRow(): CustomVariableRow {
  rowIdCounter++;
  return { id: rowIdCounter, name: "", source: "literal", value: "", columnKey: "" };
}

export function PushToEmailBisonButton({
  paramsStr,
  total,
  virtualColumns = [],
  onDone,
}: {
  paramsStr: string;
  total: number;
  /** Active virtual/enrichment columns on the current People view — offered
   * as bind targets for a column-bound custom-variable row, alongside the
   * standard People-table fields in BINDABLE_RECORD_COLUMNS. */
  virtualColumns?: ActiveVirtualColumn[];
  /** Fired once the push stream reaches its `done` event — mirrors
   * PushToGhlButton's onDone. */
  onDone?: () => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [step, setStep] = useState<Step>("picker");
  const [pushLabel, setPushLabel] = useState<string | null>(null);

  const [clients, setClients] = useState<ActiveClient[] | null>(null);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  const [existingLeadBehavior, setExistingLeadBehavior] = useState<"patch" | "put">("patch");
  const [rows, setRows] = useState<CustomVariableRow[]>([]);

  const [referenceVariables, setReferenceVariables] = useState<EmailBisonCustomVariable[] | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);

  // Custom_data enrichment fields present in the currently filtered/selected
  // people, offered as extra bind targets alongside BINDABLE_RECORD_COLUMNS
  // and virtualColumns — same discovery endpoint the "Add column from
  // enrichment" picker uses (app/api/people/enrichment-fields), already
  // scoped + housekeeping-key-filtered server-side.
  const [enrichmentFields, setEnrichmentFields] = useState<EnrichmentField[]>([]);

  // Pre-populated via resolveDefaultFieldMapping (issue #108) on step entry,
  // by GET /api/emailbison/default-field-mapping — the same candidate set the
  // push itself would resolve. Null while that fetch is in flight; every row
  // is then overridable via StandardFieldMappingTable before confirming
  // (issue #112).
  const [standardFieldMapping, setStandardFieldMapping] = useState<EmailBisonStandardFieldMapping | null>(
    null
  );
  const [standardFieldMappingError, setStandardFieldMappingError] = useState<string | null>(null);
  // In-flight guard for the picker → options transition: keeps a re-click (or
  // a reopen) from re-firing the field-mapping endpoints while they're loading.
  const [pickerLoading, setPickerLoading] = useState(false);

  const busy = status === "pushing";
  const selectedClient = clients?.find((c) => c.id === selectedClientId) ?? null;

  // Registers this dialog with the shared dialog stack so other prompts — e.g.
  // the post-push "remove temporary columns?" prompt — defer until it closes
  // rather than stacking on top of it (issue #89).
  useRegisterDialogOpen(status !== "idle");

  function reset() {
    setStatus("idle");
    setStep("picker");
    setPushLabel(null);
    setClients(null);
    setClientsError(null);
    setSelectedClientId(null);
    setExistingLeadBehavior("patch");
    setRows([]);
    setReferenceVariables(null);
    setReferenceError(null);
    setEnrichmentFields([]);
    setStandardFieldMapping(null);
    setStandardFieldMappingError(null);
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

  async function handleContinueFromPicker() {
    if (!selectedClient || !selectedClient.hasEmailBisonCredentials) return;
    if (pickerLoading) return;

    const client = selectedClient;
    setStep("options");
    setReferenceVariables(null);
    setReferenceError(null);
    setEnrichmentFields([]);
    setStandardFieldMapping(null);
    setStandardFieldMappingError(null);
    setPickerLoading(true);

    // These endpoints are independent, so fire them together instead of
    // awaiting each in series (issue: the dialog took 13-23s to open). Each
    // keeps its own error handling; the saved-mapping override is applied on
    // top of the auto-mapping default purely for ordering, not because the two
    // requests depend on each other — so it fetches in parallel too.
    const referencePromise = (async () => {
      try {
        const res = await fetch(`/api/clients/${client.id}/emailbison-custom-variables`);
        if (!res.ok) throw new Error("Failed to load existing custom variables");
        const data = (await res.json()) as { variables: EmailBisonCustomVariable[] };
        setReferenceVariables(data.variables);
      } catch (error) {
        setReferenceError((error as Error).message || "Failed to load existing custom variables.");
      }
    })();

    // Best-effort: the column dropdown just falls back to the standard +
    // active-virtual-column fields if this fails, so a fetch error here
    // isn't worth its own error banner.
    const enrichmentPromise = (async () => {
      try {
        const res = await fetch(`/api/people/enrichment-fields?${paramsStr}`);
        if (!res.ok) throw new Error(res.status.toString());
        const data = (await res.json()) as { fields: EnrichmentField[] };
        setEnrichmentFields(data.fields);
      } catch {
        setEnrichmentFields([]);
      }
    })();

    // Ticket #114: a saved mapping for this (client, "emailbison_people") pair —
    // if one exists — overrides the pure auto-mapping default. Best-effort: a
    // fetch failure just leaves the auto-mapping default in place, same as
    // having no saved mapping.
    const savedPromise = fetchSavedPushFieldMapping<SavedEmailBisonFieldMapping>(
      client.id,
      "emailbison_people"
    ).catch(() => null);

    const mappingPromise = (async () => {
      let base: EmailBisonStandardFieldMapping;
      try {
        const res = await fetch(`/api/emailbison/default-field-mapping?entity=people&${paramsStr}`);
        if (!res.ok) throw new Error("Failed to load default field mapping");
        const data = (await res.json()) as { standardFields: EmailBisonStandardFieldMapping };
        base = data.standardFields;
      } catch (error) {
        setStandardFieldMappingError((error as Error).message || "Failed to load default field mapping.");
        return;
      }
      const saved = await savedPromise;
      setStandardFieldMapping(saved ? normalizeSavedMapping(saved.standardFields) : base);
    })();

    try {
      await Promise.all([referencePromise, enrichmentPromise, mappingPromise]);
    } finally {
      setPickerLoading(false);
    }
  }

  function addRow() {
    setRows((prev) => [...prev, newRow()]);
  }

  function removeRow(id: number) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  function updateRow(id: number, patch: Partial<CustomVariableRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  /** Adds a custom-variable row pre-filled with an existing workspace
   * variable's name so the user only has to pick its source, rather than
   * retyping the name. Sourced-from-column by default since that's the point
   * of clicking a known variable; a no-op if a row with that name already
   * exists, to avoid silent duplicates. */
  function addVariableFromReference(name: string) {
    setRows((prev) =>
      prev.some((r) => r.name.trim() === name)
        ? prev
        : [...prev, { ...newRow(), name, source: "column" }]
    );
  }

  function handleConfirmOptions() {
    setStep("confirm");
  }

  // A custom-variable row is invalid if its name is blank, or it's bound to
  // "Column" but no column has actually been chosen — either would silently
  // get dropped by customVariablesForPush()'s filter, so gate Continue on it
  // instead of letting the row vanish without explanation (issue #86).
  const hasInvalidCustomVariableRow = rows.some(
    (r) => r.name.trim() === "" || (r.source === "column" && r.columnKey === "")
  );

  function customVariablesForPush(): EmailBisonCustomVariableEntry[] {
    return rows
      .filter(
        (r) => r.name.trim() !== "" && (r.source === "literal" ? r.value.trim() !== "" : r.columnKey !== "")
      )
      .map((r) =>
        r.source === "literal"
          ? { name: r.name.trim(), value: r.value }
          : { name: r.name.trim(), value: "", columnKey: r.columnKey }
      );
  }

  async function handleConfirm() {
    if (!selectedClient) return;

    setStatus("pushing");
    setPushLabel("Queuing…");

    // Ticket #114: save the mapping actually being used as the new starting
    // point for the next push to this (client, "emailbison_people") pair.
    // Fire-and-forget — never blocks or fails the push; only ever affects
    // future pushes. Skipped when null (e.g. the default-mapping fetch
    // failed) so a saved override isn't wiped by an unrelated fetch error.
    if (standardFieldMapping) {
      savePushFieldMapping(selectedClient.id, "emailbison_people", {
        standardFields: standardFieldMapping,
      } satisfies SavedEmailBisonFieldMapping).catch(() => {});
    }

    // Pushes now run as durable background jobs (issue #120): POST enqueues a
    // push_jobs row and returns immediately. Rather than block the dialog on
    // the run, we toast and close — live progress and the completion summary
    // live in the Push Activity panel (issue #122).
    try {
      const res = await fetch(`/api/emailbison/push?${paramsStr}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: "people",
          action: "workspace",
          clientId: selectedClient.id,
          existingLeadBehavior,
          customVariables: customVariablesForPush(),
          standardFieldMapping: standardFieldMapping ?? undefined,
        }),
      });
      if (!res.ok) {
        const message = (await res.json().catch(() => null))?.error ?? "Failed to start push";
        throw new Error(message);
      }
    } catch (error) {
      showToast((error as Error).message || "Failed to queue push — try again.", "error");
      console.error("Push to EmailBison error:", error);
      reset();
      return;
    }

    showToast("Push queued — track it in Push Activity", "success");
    onDone?.();
    reset();
  }

  const label = status === "pushing" && pushLabel ? pushLabel : "Add to EmailBison";

  // Standard fields, then active virtual columns, then every other
  // enrichment (custom_data) key discovered on the current view — deduped by
  // key so a field that's both an active virtual column and in the
  // discovery sample isn't offered twice.
  const bindableColumnKeys = new Set(BINDABLE_RECORD_COLUMNS.map((c) => c.key));
  const bindableColumns = [...BINDABLE_RECORD_COLUMNS];
  for (const c of virtualColumns) {
    if (bindableColumnKeys.has(c.key)) continue;
    bindableColumnKeys.add(c.key);
    bindableColumns.push({ key: c.key, label: c.key });
  }
  for (const f of enrichmentFields) {
    if (bindableColumnKeys.has(f.key)) continue;
    bindableColumnKeys.add(f.key);
    bindableColumns.push({ key: f.key, label: f.key });
  }

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
        aria-label="Add to EmailBison"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
        {label}
      </button>

      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />

        {step === "picker" ? (
          <AlertDialog.Content className="fixed top-[24%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Add to EmailBison — choose a client
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              Select which client&apos;s EmailBison workspace will receive the{" "}
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
                      client.hasEmailBisonCredentials ? "cursor-pointer hover:bg-hover" : "opacity-50"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="emailbison-client"
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
                disabled={!selectedClient?.hasEmailBisonCredentials || pickerLoading}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                  selectedClient?.hasEmailBisonCredentials && !pickerLoading
                    ? "bg-stamp hover:opacity-90"
                    : "bg-stamp/40 cursor-not-allowed"
                )}
              >
                {pickerLoading ? "Loading…" : "Continue →"}
              </button>
            </div>
          </AlertDialog.Content>
        ) : step === "options" ? (
          <AlertDialog.Content className="fixed top-[10%] left-1/2 z-50 max-h-[80vh] w-full max-w-lg -translate-x-1/2 overflow-y-auto rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Lead behavior &amp; custom variables
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <div className="mt-4 flex flex-col gap-5 text-sm text-ink-soft">
                <div>
                  <p className="text-xs font-medium text-ink">Existing lead behavior</p>
                  <p className="mt-1 text-xs text-ink-mute">
                    How to handle a person who already exists as a lead in this workspace.
                  </p>
                  <div className="mt-2 flex flex-col gap-1.5">
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="radio"
                        name="existing-lead-behavior"
                        checked={existingLeadBehavior === "patch"}
                        onChange={() => setExistingLeadBehavior("patch")}
                      />
                      <span className="text-ink">
                        Partial update{" "}
                        <span className="text-ink-mute">
                          — EmailBison merges these fields into the existing lead (default)
                        </span>
                      </span>
                    </label>
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="radio"
                        name="existing-lead-behavior"
                        checked={existingLeadBehavior === "put"}
                        onChange={() => setExistingLeadBehavior("put")}
                      />
                      <span className="text-ink">
                        Full replace{" "}
                        <span className="text-ink-mute">
                          — EmailBison blanks out any field not included here
                        </span>
                      </span>
                    </label>
                  </div>
                </div>

                {standardFieldMappingError ? (
                  <p className="text-xs text-danger">{standardFieldMappingError}</p>
                ) : standardFieldMapping === null ? (
                  <p className="flex items-center gap-2 text-xs text-ink-soft">
                    <Loader2 size={12} className="animate-spin" />
                    Loading default field mapping…
                  </p>
                ) : (
                  <StandardFieldMappingTable
                    value={standardFieldMapping}
                    columns={bindableColumns}
                    onChange={setStandardFieldMapping}
                  />
                )}

                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-ink">Custom variables</p>
                    <button
                      type="button"
                      onClick={addRow}
                      className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-1 text-xs font-medium text-ink transition-smooth hover:bg-hover"
                    >
                      <Plus size={12} /> Add variable
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-ink-mute">
                    Each variable name is sent with either a literal value or a value bound to a
                    People-table column/virtual column for each pushed person.
                  </p>

                  {rows.length > 0 ? (
                    <div className="mt-3 flex flex-col gap-2">
                      {rows.map((row) => {
                        const nameInvalid = row.name.trim() === "";
                        const columnInvalid = row.source === "column" && row.columnKey === "";
                        return (
                          <div
                            key={row.id}
                            className={cn(
                              "flex items-center gap-2 rounded-md border p-2",
                              nameInvalid || columnInvalid ? "border-danger/60" : "border-rule"
                            )}
                          >
                            <input
                              type="text"
                              placeholder="Variable name"
                              value={row.name}
                              onChange={(e) => updateRow(row.id, { name: e.target.value })}
                              className={cn(
                                "w-28 rounded-md border bg-transparent px-2 py-1 text-xs text-ink",
                                nameInvalid ? "border-danger/60" : "border-rule"
                              )}
                            />
                            <select
                              value={row.source}
                              onChange={(e) =>
                                updateRow(row.id, { source: e.target.value as "literal" | "column" })
                              }
                              className="rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                            >
                              <option value="literal">Static value</option>
                              <option value="column">Column</option>
                            </select>
                            {row.source === "literal" ? (
                              <input
                                type="text"
                                placeholder="Value"
                                value={row.value}
                                onChange={(e) => updateRow(row.id, { value: e.target.value })}
                                className="flex-1 rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                              />
                            ) : (
                              <select
                                value={row.columnKey}
                                onChange={(e) => updateRow(row.id, { columnKey: e.target.value })}
                                className={cn(
                                  "flex-1 rounded-md border bg-transparent px-2 py-1 text-xs text-ink",
                                  columnInvalid ? "border-danger/60" : "border-rule"
                                )}
                              >
                                <option value="">Choose a column…</option>
                                {bindableColumns.map((col) => (
                                  <option key={col.key} value={col.key}>
                                    {col.label}
                                  </option>
                                ))}
                              </select>
                            )}
                            <button
                              type="button"
                              onClick={() => removeRow(row.id)}
                              aria-label="Remove variable"
                              className="text-ink-mute transition-smooth hover:text-danger"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  {hasInvalidCustomVariableRow ? (
                    <p className="mt-2 text-xs text-danger">
                      Give every custom variable a name, and choose a column for any row set to
                      &quot;Column&quot;.
                    </p>
                  ) : null}
                </div>

                <div>
                  <p className="text-xs font-medium text-ink">
                    Existing workspace variables <span className="text-ink-mute">(reference only)</span>
                  </p>
                  <div className="mt-2 max-h-28 overflow-y-auto rounded-md border border-rule p-2">
                    {referenceError ? (
                      <p className="text-xs text-danger">{referenceError}</p>
                    ) : referenceVariables === null ? (
                      <p className="flex items-center gap-2 text-xs text-ink-soft">
                        <Loader2 size={12} className="animate-spin" />
                        Loading…
                      </p>
                    ) : referenceVariables.length === 0 ? (
                      <p className="text-xs text-ink-mute">No custom variables in this workspace yet.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {referenceVariables.map((v) => (
                          <button
                            key={v.id}
                            type="button"
                            onClick={() => addVariableFromReference(v.name)}
                            title={`Add "${v.name}" as a custom variable`}
                            aria-label={`Add "${v.name}" as a custom variable`}
                            className="cursor-pointer rounded-full border border-rule px-2 py-0.5 text-xs text-ink-soft transition-smooth hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-stamp/50"
                          >
                            + {v.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
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
                onClick={handleConfirmOptions}
                disabled={hasInvalidCustomVariableRow}
                title={
                  hasInvalidCustomVariableRow
                    ? "Fix the incomplete custom variable row(s) before continuing"
                    : undefined
                }
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                  hasInvalidCustomVariableRow
                    ? "bg-stamp/40 cursor-not-allowed"
                    : "bg-stamp hover:opacity-90"
                )}
              >
                Continue →
              </button>
            </div>
          </AlertDialog.Content>
        ) : (
          <AlertDialog.Content className="fixed top-[26%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Push to {selectedClient?.name}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              <strong className="text-ink">{total.toLocaleString("en-US")}</strong> people in the
              current view will be created or updated as EmailBison leads. No quality filter is
              applied — this is exactly the currently filtered/selected set.
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
                Push {total.toLocaleString("en-US")}
              </button>
            </div>
          </AlertDialog.Content>
        )}
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
