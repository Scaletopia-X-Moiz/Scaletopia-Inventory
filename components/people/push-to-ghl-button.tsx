"use client";

import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { Loader2, Send } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";
import { fetchActiveClients } from "@/lib/data/active-clients-client";
import { useRegisterDialogOpen } from "@/components/shared/dialog-stack";
import type { GhlCustomField } from "@/lib/ghl/custom-fields";
import type { GhlFieldMapping, GhlStandardFieldMapping } from "@/lib/ghl/types";
import { normalizeGhlFieldSource } from "@/lib/ghl/contact-payload";
import {
  LITERAL_SENTINEL,
  isLiteralSource,
  literalSourceText,
  toLiteralSource,
} from "@/lib/push/standard-field-source";
import {
  normalizeSavedGhlCustomFieldMapping,
  type SavedGhlCustomFieldMappingEntry,
} from "@/lib/ghl/field-mapping";
import type { ActiveVirtualColumn } from "@/lib/data/virtual-columns";
import type { EnrichmentField } from "@/lib/data/enrichment-fields";
import {
  fetchSavedPushFieldMapping,
  savePushFieldMapping,
} from "@/lib/data/push-field-mappings-client";

/** Stored shape for platform "ghl" in push_field_mappings (ticket #114,
 * extended by #142 for literal-value support). `customFieldMapping` is
 * normalized on read (normalizeSavedGhlCustomFieldMapping) so a legacy row
 * saved before #142 (a plain virtualColumnKey string per ghlFieldId) still
 * loads correctly. */
interface SavedGhlFieldMapping {
  standardFields: GhlStandardFieldMapping;
  customFieldMapping: Record<string, SavedGhlCustomFieldMappingEntry>;
}

/** A GHL custom field's mapping-table row state — "ignore" leaves the field
 * out of the push entirely (renamed from the old "No data" option to match
 * the CSV-import MappingTable's "— ignore —" convention), "literal" sends
 * `value` verbatim to every contact, "column" resolves `columnKey` per
 * candidate (a bound standard field or virtual/enrichment column). */
interface CustomFieldRowState {
  source: "column" | "literal" | "ignore";
  columnKey: string;
  value: string;
}

/** Standard People-table fields bindable by a custom-field row — mirrors
 * EmailBison's BINDABLE_RECORD_COLUMNS (components/people/push-to-emailbison-button.tsx)
 * over GHL's own field set (lib/ghl/contact-payload.ts's GHL_KNOWN_RECORD_FIELDS).
 * Must stay a superset of GHL_KNOWN_RECORD_FIELDS's keys — resolveDefaultFieldMapping
 * (lib/push/resolve-default-field-mapping.ts) auto-maps against that same field
 * set, and an auto-matched columnKey with no corresponding <option> here would
 * render as a blank/unselected row. brandName is included for that reason even
 * though "Company name" (bound to companyName) already prefers it. */
const BINDABLE_RECORD_COLUMNS: { key: string; label: string }[] = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "companyName", label: "Company name" },
  { key: "brandName", label: "Cleaned brand name" },
  { key: "city", label: "City" },
  { key: "country", label: "Country" },
  { key: "niche", label: "Niche" },
  { key: "employeeCount", label: "Employee count" },
  { key: "source", label: "Source" },
];

function ScoreIndicator({ score }: { score: number }) {
  if (score >= 0.8) return <span className="inline-block h-2 w-2 rounded-full bg-green-500" title="High confidence" />;
  if (score >= 0.5) return <span className="inline-block h-2 w-2 rounded-full bg-yellow-500" title="Medium confidence" />;
  if (score > 0) return <span className="inline-block h-2 w-2 rounded-full bg-orange-400" title="Low confidence" />;
  return <span className="inline-block h-2 w-2 rounded-full bg-rule" title="No match" />;
}

/** Reset baseline for standardFields between pushes — matches
 * resolveDefaultFieldMapping's (ticket #108) "no brand_name in the pushed
 * set" default (free-source mapping: each field defaults to its own record
 * column) so state is never in an undefined shape between the picker step
 * and the mapping step's fetch resolving. */
const FALLBACK_STANDARD_FIELDS: GhlStandardFieldMapping = {
  companyName: "companyName",
  firstName: "firstName",
  lastName: "lastName",
  email: "email",
  phone: "phone",
  city: "city",
  country: "country",
};

/** Standard-field keys, in the same order the mapping table renders them —
 * used both to render the free-source rows below and to normalize a saved
 * mapping field-by-field on load (normalizeSavedMapping). */
const STANDARD_FIELD_KEYS: (keyof GhlStandardFieldMapping)[] = [
  "companyName",
  "firstName",
  "lastName",
  "email",
  "phone",
  "city",
  "country",
];

const STANDARD_FIELD_ROWS: { key: keyof Omit<GhlStandardFieldMapping, "companyName">; label: string }[] = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "city", label: "City" },
  { key: "country", label: "Country" },
];

/** A saved mapping (ticket #114) may still be shaped like the pre-free-source
 * include/skip + 3-way companyName enum — normalize every field through
 * normalizeGhlFieldSource so an old saved mapping renders correctly in the
 * new dropdown-per-field table instead of showing a stale/invalid option. */
function normalizeSavedMapping(mapping: GhlStandardFieldMapping): GhlStandardFieldMapping {
  const result = {} as GhlStandardFieldMapping;
  for (const key of STANDARD_FIELD_KEYS) {
    result[key] = normalizeGhlFieldSource(key, mapping[key]);
  }
  return result;
}

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

type Status = "idle" | "open" | "pushing";
type Step = "picker" | "mapping" | "confirm";

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
  // ghlFieldId -> row state (source/columnKey/value).
  const [mapping, setMapping] = useState<Record<string, CustomFieldRowState>>({});
  // ghlFieldId -> fuzzyMatchColumn score from the auto-mapping default, for
  // the mapping table's confidence dot (ScoreIndicator).
  const [matchScores, setMatchScores] = useState<Record<string, number>>({});
  const [standardFields, setStandardFields] = useState<GhlStandardFieldMapping>(FALLBACK_STANDARD_FIELDS);

  // Custom_data enrichment fields present in the currently filtered/selected
  // people, offered as extra bind targets alongside BINDABLE_RECORD_COLUMNS
  // and virtualColumns — same discovery endpoint the EmailBison button uses
  // (app/api/people/enrichment-fields), already scoped server-side.
  const [enrichmentFields, setEnrichmentFields] = useState<EnrichmentField[]>([]);

  const [preview, setPreview] = useState<PreviewCounts | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [customTagSuffix, setCustomTagSuffix] = useState("");

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
    setCustomFields(null);
    setCustomFieldsError(null);
    setMapping({});
    setMatchScores({});
    setEnrichmentFields([]);
    setStandardFields(FALLBACK_STANDARD_FIELDS);
    setPreview(null);
    setPreviewError(null);
    setCustomTagSuffix("");
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
    setMatchScores({});
    setEnrichmentFields([]);
    setStandardFields(FALLBACK_STANDARD_FIELDS);

    // Best-effort, mirrors the EmailBison button's enrichment-fields fetch —
    // the column dropdown just falls back to standard + active virtual
    // columns if this fails.
    (async () => {
      try {
        const res = await fetch(`/api/people/enrichment-fields?${paramsStr}`);
        if (!res.ok) throw new Error(res.status.toString());
        const data = (await res.json()) as { fields: EnrichmentField[] };
        setEnrichmentFields(data.fields);
      } catch {
        setEnrichmentFields([]);
      }
    })();

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
        customFieldScores: Record<string, number>;
      };
      setCustomFields(data.customFields);
      setStandardFields(data.standardFields);
      setMatchScores(data.customFieldScores);
      const defaultMapping: Record<string, CustomFieldRowState> = {};
      for (const field of data.customFields) defaultMapping[field.id] = { source: "ignore", columnKey: "", value: "" };
      for (const m of data.customFieldMapping) {
        defaultMapping[m.ghlFieldId] = { source: "column", columnKey: m.columnKey ?? "", value: "" };
      }
      setMapping(defaultMapping);

      // Ticket #114: a saved mapping for this (client, "ghl") pair — if one
      // exists — overrides the pure auto-mapping default just applied above.
      // normalizeSavedGhlCustomFieldMapping (ticket #142) upgrades a legacy
      // row (plain virtualColumnKey string per ghlFieldId) to the current
      // shape. Best-effort: a fetch failure just leaves the auto-mapping
      // default in place, same as having no saved mapping at all.
      try {
        const saved = await fetchSavedPushFieldMapping<SavedGhlFieldMapping>(selectedClient.id, "ghl");
        if (saved) {
          setStandardFields(normalizeSavedMapping(saved.standardFields));
          const normalized = normalizeSavedGhlCustomFieldMapping(saved.customFieldMapping);
          setMapping((prev) => {
            const next = { ...prev };
            for (const field of data.customFields) {
              const entry = normalized[field.id];
              next[field.id] = entry
                ? { source: entry.source, columnKey: entry.columnKey ?? "", value: entry.value ?? "" }
                : { source: "ignore", columnKey: "", value: "" };
            }
            return next;
          });
        }
      } catch {
        // keep auto-mapping default
      }
    } catch (error) {
      setCustomFieldsError((error as Error).message || "Failed to load field mapping.");
    }
  }

  function updateCustomFieldMapping(ghlFieldId: string, patch: Partial<CustomFieldRowState>) {
    setMapping((prev) => ({
      ...prev,
      [ghlFieldId]: { ...(prev[ghlFieldId] ?? { source: "ignore", columnKey: "", value: "" }), ...patch },
    }));
  }

  function handleStandardFieldChange(key: keyof GhlStandardFieldMapping, value: string) {
    setStandardFields((prev) => ({ ...prev, [key]: value }));
  }

  async function handleConfirm() {
    if (!selectedClient) return;

    setStatus("pushing");
    setPushLabel("Queuing…");

    // A row is sent only when it has something to send: "ignore", an unset
    // "column" row (no columnKey chosen), and a blank "literal" row are all
    // left out — matching the old "" == "no data source" convention and
    // preventing a blank literal from silently overwriting the field with
    // an empty string on every contact in the push.
    const activeEntries = Object.entries(mapping).filter(
      ([, m]) =>
        m.source !== "ignore" &&
        !(m.source === "column" && m.columnKey === "") &&
        !(m.source === "literal" && m.value === "")
    );
    const fieldMapping: GhlFieldMapping[] = activeEntries.map(([ghlFieldId, m]) =>
      m.source === "literal"
        ? { ghlFieldId, source: "literal", value: m.value }
        : { ghlFieldId, source: "column", columnKey: m.columnKey }
    );
    const customFieldMappingToSave: Record<string, SavedGhlCustomFieldMappingEntry> = {};
    for (const [ghlFieldId, m] of activeEntries) {
      customFieldMappingToSave[ghlFieldId] =
        m.source === "literal" ? { source: "literal", value: m.value } : { source: "column", columnKey: m.columnKey };
    }

    // Ticket #114: save the mapping actually being used as the new starting
    // point for the next push to this (client, "ghl") pair. Fire-and-forget —
    // never blocks or fails the push itself; only ever affects future pushes.
    savePushFieldMapping(selectedClient.id, "ghl", {
      standardFields,
      customFieldMapping: customFieldMappingToSave,
    } satisfies SavedGhlFieldMapping).catch(() => {});

    // Pushes now run as durable background jobs (issue #120): POST enqueues a
    // push_jobs row and returns immediately. Rather than block the dialog on
    // the run, we toast and close — live progress and the completion summary
    // live in the Push Activity panel (issue #122).
    try {
      const res = await fetch(`/api/people/push-to-ghl?${paramsStr}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientId: selectedClient.id,
          fieldMapping,
          standardFieldMapping: standardFields,
          customTagSuffix: customTagSuffix.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const message = (await res.json().catch(() => null))?.error ?? "Failed to start push";
        throw new Error(message);
      }
    } catch (error) {
      showToast((error as Error).message || "Failed to queue push — try again.", "error");
      console.error("Push to GHL error:", error);
      reset();
      return;
    }

    showToast("Push queued — track it in Push Activity", "success");
    onDone?.();
    reset();
  }

  const label = status === "pushing" && pushLabel ? pushLabel : "Push to GHL";

  // Standard fields, then active virtual columns, then every other
  // enrichment (custom_data) key discovered on the current view — deduped by
  // key, mirrors the EmailBison button's bindableColumns.
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
          <AlertDialog.Content className="fixed top-[10%] left-1/2 z-50 max-h-[80vh] w-full max-w-lg -translate-x-1/2 overflow-y-auto rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Map fields for GHL
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              Review where each field is sourced from before pushing — defaults are pre-selected,
              override any row or ignore a field to leave it out of this push.
            </AlertDialog.Description>

            <div className="mt-4 overflow-hidden rounded-lg border border-rule">
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
                      {(
                        [
                          { key: "companyName" as const, label: "Company name" },
                          ...STANDARD_FIELD_ROWS,
                        ] as { key: keyof GhlStandardFieldMapping; label: string }[]
                      ).map((row) => {
                        const raw = standardFields[row.key];
                        const literal = isLiteralSource(raw);
                        return (
                          <tr key={row.key} className="bg-paper">
                            <td className="px-4 py-2.5 text-xs font-medium text-ink">{row.label}</td>
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-1.5">
                                <select
                                  value={literal ? LITERAL_SENTINEL : raw}
                                  onChange={(e) =>
                                    handleStandardFieldChange(
                                      row.key,
                                      e.target.value === LITERAL_SENTINEL ? toLiteralSource("") : e.target.value
                                    )
                                  }
                                  className="rounded border border-rule bg-paper px-2 py-1 text-xs text-ink outline-none focus:border-stamp"
                                >
                                  <option value="skip">— ignore —</option>
                                  <option value={LITERAL_SENTINEL}>Static value</option>
                                  {bindableColumns.map((col) => (
                                    <option key={col.key} value={col.key}>
                                      {col.label}
                                    </option>
                                  ))}
                                </select>
                                {literal ? (
                                  <input
                                    type="text"
                                    placeholder="Value"
                                    value={literalSourceText(raw)}
                                    onChange={(e) =>
                                      handleStandardFieldChange(row.key, toLiteralSource(e.target.value))
                                    }
                                    className="w-full rounded border border-rule bg-paper px-2 py-1 text-xs text-ink outline-none focus:border-stamp"
                                  />
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                      {customFields.map((field) => {
                        const row = mapping[field.id] ?? { source: "ignore" as const, columnKey: "", value: "" };
                        const score = matchScores[field.id] ?? 0;
                        return (
                          <tr key={field.id} className="bg-paper">
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-2">
                                <ScoreIndicator score={row.source === "ignore" ? 0 : score} />
                                <span className="text-xs font-medium text-ink">{field.name}</span>
                              </div>
                            </td>
                            <td className="px-4 py-2.5">
                              <div className="flex items-center gap-1.5">
                                <select
                                  value={row.source}
                                  onChange={(e) =>
                                    updateCustomFieldMapping(field.id, {
                                      source: e.target.value as CustomFieldRowState["source"],
                                    })
                                  }
                                  className="rounded border border-rule bg-paper px-2 py-1 text-xs text-ink outline-none focus:border-stamp"
                                >
                                  <option value="ignore">— ignore —</option>
                                  <option value="column">Column</option>
                                  <option value="literal">Static value</option>
                                </select>
                                {row.source === "column" ? (
                                  <select
                                    value={row.columnKey}
                                    onChange={(e) => updateCustomFieldMapping(field.id, { columnKey: e.target.value })}
                                    className="w-full rounded border border-rule bg-paper px-2 py-1 text-xs text-ink outline-none focus:border-stamp"
                                  >
                                    <option value="">Choose a column…</option>
                                    {bindableColumns.map((col) => (
                                      <option key={col.key} value={col.key}>
                                        {col.label}
                                      </option>
                                    ))}
                                  </select>
                                ) : row.source === "literal" ? (
                                  <input
                                    type="text"
                                    placeholder="Value"
                                    value={row.value}
                                    onChange={(e) => updateCustomFieldMapping(field.id, { value: e.target.value })}
                                    className="w-full rounded border border-rule bg-paper px-2 py-1 text-xs text-ink outline-none focus:border-stamp"
                                  />
                                ) : null}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
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
        ) : (
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
                Tag (optional)
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
                Applied to every contact in this push. Leave blank to push with no tag.
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
        )}
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
