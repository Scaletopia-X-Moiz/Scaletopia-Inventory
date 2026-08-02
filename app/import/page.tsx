"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { cn, formatAbsoluteDateTime, timeAgo } from "@/lib/utils";
import {
  BUILTIN_PROVIDERS,
  COMPANIES_FIELDS,
  PEOPLE_FIELDS,
  type ProviderPreset,
  type TargetTable,
} from "@/lib/import/providers";
import { fuzzyMatchColumn } from "@/lib/import/normalize";
import { parseCSV, applyColumnMap, filterMappedNonEmptyRows, serializeCSV } from "@/lib/import/csv";
import { summarizeFailures } from "@/lib/import/failure-messages";
import { Upload, History, CheckCircle, AlertCircle, Loader2, Download, ChevronRight, RefreshCw } from "lucide-react";

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

interface ParsedCSV {
  headers: string[];
  sampleRows: Record<string, string>[];
  allText: string;
  rowCount: number;
}

interface ColumnMapping {
  csvHeader: string;
  supabaseField: string;
  score: number;
}

interface WizardMeta {
  provider: ProviderPreset | null;
  customSourceKey: string;
  targetTable: TargetTable;
  columnMappings: ColumnMapping[];
  // "This file also contains company data" toggle (only meaningful when the
  // effective target table is "people") plus the second column-map section
  // it unlocks. When false, both of these are no-ops everywhere they're read.
  companySyncEnabled: boolean;
  companyColumnMappings: ColumnMapping[];
  client: string;
  niche: string;
  date: string;
}

interface PushProgress {
  phase: string;
  done: number;
  total: number;
  message?: string;
}

interface PushResult {
  inputCount: number;
  dedupedCount: number;
  insertedCount: number;
  updatedCount: number;
  failedCount: number;
  failedRecords: Record<string, unknown>[];
  historyId: string | null;
}

interface HistoryRow {
  id: string;
  source_key: string;
  display_name: string;
  target_table: string;
  tags: string[];
  input_count: number;
  deduped_count: number;
  inserted_count: number;
  updated_count: number;
  failed_count: number;
  started_at: string;
  completed_at: string | null;
}

// ────────────────────────────────────────────────────────────────────────────
// CSV parser (no external libs)
// ────────────────────────────────────────────────────────────────────────────

function parseCSVPreview(text: string, previewRows = 5): ParsedCSV {
  const rawLines = text.split(/\r?\n/);
  const lines = rawLines.filter((l) => l.trim());
  if (lines.length === 0) return { headers: [], sampleRows: [], allText: text, rowCount: 0 };

  function parseLine(line: string): string[] {
    const fields: string[] = [];
    let i = 0;
    while (i < line.length) {
      if (line[i] === '"') {
        let field = "";
        i++;
        while (i < line.length) {
          if (line[i] === '"' && line[i + 1] === '"') {
            field += '"';
            i += 2;
          } else if (line[i] === '"') {
            i++;
            break;
          } else {
            field += line[i];
            i++;
          }
        }
        fields.push(field);
        if (line[i] === ",") i++;
      } else {
        const commaIdx = line.indexOf(",", i);
        if (commaIdx === -1) {
          fields.push(line.slice(i));
          break;
        } else {
          fields.push(line.slice(i, commaIdx));
          i = commaIdx + 1;
        }
      }
    }
    return fields;
  }

  const headers = parseLine(lines[0]);
  const sampleRows: Record<string, string>[] = [];
  const end = Math.min(previewRows + 1, lines.length);

  for (let li = 1; li < end; li++) {
    const values = parseLine(lines[li]);
    const row: Record<string, string> = {};
    for (let hi = 0; hi < headers.length; hi++) {
      row[headers[hi]] = values[hi] ?? "";
    }
    sampleRows.push(row);
  }

  return { headers, sampleRows, allText: text, rowCount: lines.length - 1 };
}

// ────────────────────────────────────────────────────────────────────────────
// Auto-suggest column mappings
// ────────────────────────────────────────────────────────────────────────────

function autoMapColumns(
  headers: string[],
  providerMap: Record<string, string>,
  targetTable: TargetTable
): ColumnMapping[] {
  const candidates = targetTable === "companies" ? COMPANIES_FIELDS : PEOPLE_FIELDS;

  const mappings = headers.map((header) => {
    // Provider preset takes precedence
    if (providerMap[header]) {
      return { csvHeader: header, supabaseField: providerMap[header], score: 1.0 };
    }
    const match = fuzzyMatchColumn(header, candidates, targetTable);
    return {
      csvHeader: header,
      supabaseField: match?.field ?? "ignore",
      score: match?.score ?? 0,
    };
  });

  // Resolve many-to-one collisions: fuzzy matching happily maps several headers
  // to the same target (Store Leads' `domain`, `platform_domain`,
  // `cluster_domains`, `domain_count` all score against `domain`), which then
  // gets saved as a preset and silently corrupts that field on every future
  // import. `custom_data` legitimately absorbs many columns; every other target
  // is single-value, so keep only the strongest header per field — preferring an
  // exact header==field name — and demote the rest to `ignore`.
  const winnerByField = new Map<string, { header: string; score: number }>();
  for (const m of mappings) {
    const f = m.supabaseField;
    if (f === "ignore" || f === "custom_data") continue;
    const exact = m.csvHeader === f;
    const current = winnerByField.get(f);
    const currentExact = current ? current.header === f : false;
    // Exact name beats any fuzzy score; otherwise higher score wins.
    if (!current || (exact && !currentExact) || (exact === currentExact && m.score > current.score)) {
      winnerByField.set(f, { header: m.csvHeader, score: m.score });
    }
  }
  return mappings.map((m) => {
    if (m.supabaseField === "ignore" || m.supabaseField === "custom_data") return m;
    const winner = winnerByField.get(m.supabaseField);
    return winner && winner.header !== m.csvHeader
      ? { ...m, supabaseField: "ignore", score: 0 }
      : m;
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Step components
// ────────────────────────────────────────────────────────────────────────────

const SLUG_RE = /^[a-z][a-z0-9-]*$/;

function TargetBadge({ table }: { table: TargetTable }) {
  return (
    <span className={cn(
      "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
      table === "companies" ? "bg-blue-100 text-blue-700" : "bg-purple-100 text-purple-700"
    )}>
      {table === "companies" ? "Companies" : "People"}
    </span>
  );
}

function StepUpload({
  onNext,
}: {
  onNext: (
    csv: ParsedCSV,
    provider: ProviderPreset | null,
    customKey: string,
    targetTable: TargetTable,
    companySyncEnabled: boolean
  ) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [csv, setCsv] = useState<ParsedCSV | null>(null);
  const [providerKey, setProviderKey] = useState("manual-csv");
  const [targetOverride, setTargetOverride] = useState<TargetTable | "">("");
  const [customProviders, setCustomProviders] = useState<ProviderPreset[]>([]);
  const [companySync, setCompanySync] = useState(false);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newKey, setNewKey] = useState("");
  const [newTable, setNewTable] = useState<TargetTable>("companies");
  const [keyErr, setKeyErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/import/mappings")
      .then((r) => r.json())
      .then((data: Array<{ source_key: string; display_name: string; target_table: string; column_map: Record<string, string> }>) => {
        if (!Array.isArray(data)) return;
        const builtinKeys = new Set(BUILTIN_PROVIDERS.map((p) => p.sourceKey));
        setCustomProviders(
          data
            .filter((row) => !builtinKeys.has(row.source_key))
            .map((row) => ({
              sourceKey: row.source_key,
              displayName: row.display_name ?? row.source_key,
              targetTable: (row.target_table ?? "companies") as TargetTable,
              columnMap: row.column_map ?? {},
            }))
        );
      })
      .catch(() => {});
  }, []);

  const allProviders = [...BUILTIN_PROVIDERS, ...customProviders];
  const selectedProvider = allProviders.find((p) => p.sourceKey === providerKey) ?? null;
  const providerHasBothTables = !!selectedProvider?.altColumnMap;
  const tableIsLocked = BUILTIN_PROVIDERS.some((p) => p.sourceKey === providerKey) && !providerHasBothTables;
  const effectiveTable: TargetTable = tableIsLocked
    ? (selectedProvider?.targetTable ?? "companies")
    : (targetOverride || selectedProvider?.targetTable || "companies");

  // Pre-check the sync toggle per the selected preset's default whenever the
  // provider or effective table changes, but let the user override it freely
  // afterwards (this effect only re-fires on those two changes).
  useEffect(() => {
    setCompanySync(effectiveTable === "people" ? (selectedProvider?.companySyncDefault ?? false) : false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerKey, effectiveTable]);

  async function handleFile(file: File) {
    const text = await file.text();
    setCsv(parseCSVPreview(text));
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFile(file);
  }

  async function addProvider() {
    const slug = newKey.trim();
    if (!SLUG_RE.test(slug)) {
      setKeyErr("Must be lowercase letters, digits, and hyphens (e.g. my-tool)");
      return;
    }
    if (allProviders.some((p) => p.sourceKey === slug)) {
      setKeyErr("A provider with this key already exists");
      return;
    }
    setSaving(true);
    try {
      await fetch("/api/import/mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceKey: slug,
          displayName: newName.trim() || slug,
          targetTable: newTable,
          columnMap: {},
        }),
      });
      const added: ProviderPreset = {
        sourceKey: slug,
        displayName: newName.trim() || slug,
        targetTable: newTable,
        columnMap: {},
      };
      setCustomProviders((prev) => [...prev, added]);
      setProviderKey(slug);
      setTargetOverride("");
      setShowAddForm(false);
      setNewName("");
      setNewKey("");
      setNewTable("companies");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-base font-semibold text-ink">Upload CSV</h3>
        <p className="mt-1 text-sm text-ink-soft">Select a provider and upload your CSV file.</p>
      </div>

      {/* Provider selection */}
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium text-ink-soft uppercase tracking-wide">Provider</label>
        <select
          value={providerKey}
          onChange={(e) => { setProviderKey(e.target.value); setTargetOverride(""); }}
          className="rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
        >
          {allProviders.map((p) => (
            <option key={p.sourceKey} value={p.sourceKey}>
              {p.displayName}
            </option>
          ))}
        </select>

        {/* Add custom provider */}
        {!showAddForm ? (
          <button
            type="button"
            onClick={() => setShowAddForm(true)}
            className="self-start text-xs text-stamp hover:underline"
          >
            + Add custom provider
          </button>
        ) : (
          <div className="mt-1 flex flex-col gap-3 rounded-lg border border-rule bg-paper p-4">
            <p className="text-xs font-medium text-ink">New custom provider</p>
            <input
              type="text"
              placeholder="Display name (e.g. My Tool)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              className="rounded-lg border border-rule bg-hover px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
            />
            <div className="flex flex-col gap-1">
              <input
                type="text"
                placeholder="Source key (e.g. my-tool)"
                value={newKey}
                onChange={(e) => { setNewKey(e.target.value.toLowerCase()); setKeyErr(null); }}
                className={cn(
                  "rounded-lg border bg-hover px-3 py-2 text-sm text-ink outline-none focus:border-stamp",
                  keyErr ? "border-red-400" : "border-rule"
                )}
              />
              {keyErr && <p className="text-xs text-red-500">{keyErr}</p>}
              <p className="text-xs text-ink-mute">Lowercase letters, digits, and hyphens only</p>
            </div>
            <div className="flex gap-2">
              {(["companies", "people"] as TargetTable[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setNewTable(t)}
                  className={cn(
                    "flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors",
                    newTable === t
                      ? "border-stamp bg-stamp text-white"
                      : "border-rule text-ink-soft hover:bg-hover"
                  )}
                >
                  {t === "companies" ? "Companies" : "People"}
                </button>
              ))}
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => { setShowAddForm(false); setKeyErr(null); setNewName(""); setNewKey(""); }}
                className="flex-1 rounded-lg border border-rule px-3 py-1.5 text-xs text-ink-soft hover:bg-hover transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={addProvider}
                disabled={saving || !newKey.trim()}
                className="flex-1 rounded-lg bg-stamp px-3 py-1.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
              >
                {saving ? "Saving…" : "Confirm"}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Target table toggle */}
      <div className="flex flex-col gap-2">
        <label className="text-xs font-medium text-ink-soft uppercase tracking-wide">Target Table</label>
        {tableIsLocked ? (
          <div className="flex items-center gap-2 rounded-lg border border-rule bg-paper px-3 py-2">
            <TargetBadge table={effectiveTable} />
            <span className="text-xs text-ink-mute">Set by provider</span>
          </div>
        ) : (
          <div className="flex gap-2">
            {(["companies", "people"] as TargetTable[]).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTargetOverride(t)}
                className={cn(
                  "flex-1 rounded-lg border px-3 py-2 text-sm font-medium transition-colors",
                  effectiveTable === t
                    ? "border-stamp bg-stamp text-white"
                    : "border-rule text-ink-soft hover:bg-hover"
                )}
              >
                {t === "companies" ? "Companies" : "People"}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Company data sync toggle (people imports only) */}
      {effectiveTable === "people" && (
        <label className="flex cursor-pointer items-start gap-2.5 rounded-lg border border-rule bg-paper px-3 py-2.5">
          <input
            type="checkbox"
            checked={companySync}
            onChange={(e) => setCompanySync(e.target.checked)}
            className="mt-0.5 h-4 w-4 shrink-0 rounded border-rule"
          />
          <span className="text-sm text-ink">
            This file also contains company data — import companies too
            <span className="mt-0.5 block text-xs text-ink-mute">
              Extracts embedded company columns (e.g. domain, industry, revenue) into a
              separate Companies import, linked to these people automatically.
            </span>
          </span>
        </label>
      )}

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        onClick={() => fileRef.current?.click()}
        className={cn(
          "flex cursor-pointer flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 transition-colors",
          dragging ? "border-stamp bg-stamp/5" : "border-rule hover:border-stamp/50 hover:bg-hover"
        )}
      >
        <Upload size={32} className="text-ink-mute" />
        <div className="text-center">
          <p className="text-sm font-medium text-ink">Drop CSV here or click to browse</p>
          <p className="mt-1 text-xs text-ink-mute">.csv files only</p>
        </div>
        <input
          ref={fileRef}
          type="file"
          accept=".csv,text/csv"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
          }}
        />
      </div>

      {/* CSV preview */}
      {csv && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-ink-soft uppercase tracking-wide">
            Preview — {csv.rowCount.toLocaleString()} rows, {csv.headers.length} columns
          </p>
          <div className="overflow-x-auto rounded-lg border border-rule">
            <table className="min-w-full text-xs">
              <thead>
                <tr className="border-b border-rule bg-hover">
                  {csv.headers.map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium text-ink-soft">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-rule">
                {csv.sampleRows.map((row, i) => (
                  <tr key={i} className="bg-paper">
                    {csv.headers.map((h) => (
                      <td key={h} className="max-w-[160px] truncate whitespace-nowrap px-3 py-2 text-ink-mute">
                        {row[h] || <span className="text-rule">—</span>}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      <button
        disabled={!csv}
        onClick={() =>
          csv &&
          onNext(
            csv,
            selectedProvider,
            selectedProvider?.sourceKey ?? "custom",
            effectiveTable,
            effectiveTable === "people" && companySync
          )
        }
        className="self-end rounded-lg bg-stamp px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
      >
        Next: Map Columns
      </button>
    </div>
  );
}

function ScoreIndicator({ score }: { score: number }) {
  if (score >= 0.8) return <span className="inline-block h-2 w-2 rounded-full bg-green-500" title="High confidence" />;
  if (score >= 0.5) return <span className="inline-block h-2 w-2 rounded-full bg-yellow-500" title="Medium confidence" />;
  if (score > 0) return <span className="inline-block h-2 w-2 rounded-full bg-orange-400" title="Low confidence" />;
  return <span className="inline-block h-2 w-2 rounded-full bg-rule" title="No match" />;
}

function MappingTable({
  mappings,
  sampleRow,
  candidates,
  onChange,
}: {
  mappings: ColumnMapping[];
  sampleRow: Record<string, string> | undefined;
  candidates: string[];
  onChange: (csvHeader: string, field: string) => void;
}) {
  return (
    <div className="overflow-hidden rounded-lg border border-rule">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-rule bg-hover">
            <th className="px-4 py-2.5 text-left text-xs font-medium text-ink-soft">CSV Column</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-ink-soft">Sample</th>
            <th className="px-4 py-2.5 text-left text-xs font-medium text-ink-soft">Supabase Field</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {mappings.map((m) => (
            <tr key={m.csvHeader} className="bg-paper">
              <td className="px-4 py-2.5">
                <div className="flex items-center gap-2">
                  <ScoreIndicator score={m.supabaseField === "ignore" ? 0 : m.score} />
                  <span className="font-mono text-xs text-ink">{m.csvHeader}</span>
                </div>
              </td>
              <td className="px-4 py-2.5">
                <span className="text-xs text-ink-mute truncate block max-w-[140px]">
                  {sampleRow?.[m.csvHeader] ?? "—"}
                </span>
              </td>
              <td className="px-4 py-2.5">
                <select
                  value={m.supabaseField}
                  onChange={(e) => onChange(m.csvHeader, e.target.value)}
                  className="w-full rounded border border-rule bg-paper px-2 py-1 text-xs text-ink outline-none focus:border-stamp"
                >
                  <option value="ignore">— ignore —</option>
                  {candidates.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function StepMapping({
  csv,
  initialMappings,
  targetTable,
  sourceKey,
  companySyncEnabled,
  initialCompanyMappings,
  onNext,
  onBack,
}: {
  csv: ParsedCSV;
  initialMappings: ColumnMapping[];
  targetTable: TargetTable;
  sourceKey: string;
  companySyncEnabled: boolean;
  initialCompanyMappings: ColumnMapping[];
  onNext: (mappings: ColumnMapping[], companyMappings: ColumnMapping[]) => void;
  onBack: () => void;
}) {
  const [mappings, setMappings] = useState<ColumnMapping[]>(initialMappings);
  const [companyMappings, setCompanyMappings] = useState<ColumnMapping[]>(initialCompanyMappings);
  const candidates = targetTable === "companies" ? COMPANIES_FIELDS : PEOPLE_FIELDS;

  useEffect(() => {
    fetch(`/api/import/mappings?sourceKey=${encodeURIComponent(sourceKey)}`)
      .then((r) => r.json())
      .then((saved) => {
        if (saved?.column_map && Object.keys(saved.column_map).length > 0) {
          setMappings((prev) =>
            prev.map((m) => ({
              ...m,
              supabaseField: saved.column_map[m.csvHeader] ?? m.supabaseField,
              score: saved.column_map[m.csvHeader] ? 1.0 : m.score,
            }))
          );
        }
      })
      .catch(() => {});
  }, [sourceKey]);

  function setField(csvHeader: string, field: string) {
    setMappings((prev) =>
      prev.map((m) => (m.csvHeader === csvHeader ? { ...m, supabaseField: field } : m))
    );
  }

  function setCompanyField(csvHeader: string, field: string) {
    setCompanyMappings((prev) =>
      prev.map((m) => (m.csvHeader === csvHeader ? { ...m, supabaseField: field } : m))
    );
  }

  async function saveAndNext() {
    const columnMap: Record<string, string> = {};
    for (const m of mappings) {
      if (m.supabaseField && m.supabaseField !== "ignore") {
        columnMap[m.csvHeader] = m.supabaseField;
      }
    }
    await fetch("/api/import/mappings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sourceKey, columnMap, targetTable }),
    }).catch(() => {});
    onNext(mappings, companyMappings);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-base font-semibold text-ink">Map Columns</h3>
        <p className="mt-1 text-sm text-ink-soft">
          Match each CSV column to a Supabase field. Ignored columns won&apos;t be imported.
        </p>
      </div>

      <div className="flex flex-col gap-3">
        {companySyncEnabled && (
          <p className="text-xs font-medium text-ink-soft uppercase tracking-wide">
            {targetTable === "companies" ? "Company columns" : "People columns"}
          </p>
        )}
        <MappingTable
          mappings={mappings}
          sampleRow={csv.sampleRows[0]}
          candidates={candidates}
          onChange={setField}
        />
      </div>

      {companySyncEnabled && (
        <div className="flex flex-col gap-3">
          <div>
            <p className="text-xs font-medium text-ink-soft uppercase tracking-wide">Company columns</p>
            <p className="mt-1 text-xs text-ink-mute">
              This file also contains embedded company data. Map those columns here — they&apos;ll be
              imported into Companies and linked to the people above automatically.
            </p>
          </div>
          <MappingTable
            mappings={companyMappings}
            sampleRow={csv.sampleRows[0]}
            candidates={COMPANIES_FIELDS}
            onChange={setCompanyField}
          />
        </div>
      )}

      <div className="flex justify-between">
        <button onClick={onBack} className="rounded-lg border border-rule px-4 py-2 text-sm text-ink-soft hover:bg-hover transition-colors">
          Back
        </button>
        <button
          onClick={saveAndNext}
          className="rounded-lg bg-stamp px-5 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
        >
          Next: Metadata
        </button>
      </div>
    </div>
  );
}

function StepMetadata({
  onNext,
  onBack,
  defaultClient,
  defaultNiche,
}: {
  onNext: (client: string, niche: string, date: string) => void;
  onBack: () => void;
  defaultClient: string;
  defaultNiche: string;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const [client, setClient] = useState(defaultClient);
  const [niche, setNiche] = useState(defaultNiche);
  const [date, setDate] = useState(today);

  const [clientSuggestions, setClientSuggestions] = useState<string[]>([]);
  const [nicheSuggestions, setNicheSuggestions] = useState<string[]>([]);
  const [validationErr, setValidationErr] = useState<string | null>(null);

  useEffect(() => {
    // Merge localStorage cache with Supabase-backed suggestions
    let localClients: string[] = [];
    let localNiches: string[] = [];
    try {
      const saved = JSON.parse(localStorage.getItem("import_metadata_history") ?? "{}");
      localClients = saved.clients ?? [];
      localNiches = saved.niches ?? [];
    } catch {}

    setClientSuggestions(localClients);
    setNicheSuggestions(localNiches);

    fetch("/api/import/autocomplete")
      .then((r) => r.json())
      .then((data: { clients: string[]; niches: string[] }) => {
        if (!data.clients || !data.niches) return;
        setClientSuggestions((prev) => Array.from(new Set([...data.clients, ...prev])));
        setNicheSuggestions((prev) => Array.from(new Set([...data.niches, ...prev])));
      })
      .catch(() => {});
  }, []);

  function saveAndNext() {
    if (!client.trim() || !niche.trim() || !date) {
      setValidationErr("All three fields are required.");
      return;
    }
    try {
      const saved = JSON.parse(localStorage.getItem("import_metadata_history") ?? "{}");
      const clients = Array.from(new Set([client, ...(saved.clients ?? [])])).slice(0, 20);
      const niches = Array.from(new Set([niche, ...(saved.niches ?? [])])).slice(0, 20);
      localStorage.setItem("import_metadata_history", JSON.stringify({ clients, niches }));
    } catch {}
    onNext(client.trim(), niche.trim(), date);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-base font-semibold text-ink">Tag Metadata</h3>
        <p className="mt-1 text-sm text-ink-soft">These values tag every imported record.</p>
      </div>

      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-soft uppercase tracking-wide">Client</label>
          <input
            type="text"
            list="clients-list"
            value={client}
            onChange={(e) => { setClient(e.target.value); setValidationErr(null); }}
            placeholder="e.g. kynship"
            className="rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
          />
          <datalist id="clients-list">
            {clientSuggestions.map((s) => <option key={s} value={s} />)}
          </datalist>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-soft uppercase tracking-wide">Niche</label>
          <input
            type="text"
            list="niches-list"
            value={niche}
            onChange={(e) => { setNiche(e.target.value); setValidationErr(null); }}
            placeholder="e.g. dtc-beauty"
            className="rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
          />
          <datalist id="niches-list">
            {nicheSuggestions.map((s) => <option key={s} value={s} />)}
          </datalist>
        </div>

        <div className="flex flex-col gap-1.5">
          <label className="text-xs font-medium text-ink-soft uppercase tracking-wide">Date</label>
          <input
            type="date"
            value={date}
            onChange={(e) => { setDate(e.target.value); setValidationErr(null); }}
            className="rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
          />
        </div>
      </div>

      {validationErr && (
        <p className="flex items-center gap-1.5 text-sm text-red-500">
          <AlertCircle size={14} />
          {validationErr}
        </p>
      )}

      <div className="flex justify-between">
        <button onClick={onBack} className="rounded-lg border border-rule px-4 py-2 text-sm text-ink-soft hover:bg-hover transition-colors">
          Back
        </button>
        <button
          onClick={saveAndNext}
          className="rounded-lg bg-stamp px-5 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
        >
          Next: Review
        </button>
      </div>
    </div>
  );
}

interface PreflightResult {
  inputCount: number;
  dedupedCount: number;
  insertCount: number;
  updateCount: number;
}

function PreflightStatGrid({ preflight }: { preflight: PreflightResult }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {[
        { label: "In file", value: preflight.inputCount, color: "text-ink" },
        { label: "After dedupe", value: preflight.dedupedCount, color: "text-ink" },
        { label: "To insert", value: preflight.insertCount, color: "text-green-600" },
        { label: "To update", value: preflight.updateCount, color: "text-blue-600" },
      ].map(({ label, value, color }) => (
        <div key={label} className="rounded-lg border border-rule bg-paper px-4 py-3 text-center">
          <p className={cn("text-2xl font-bold tabular-nums", color)}>{value.toLocaleString()}</p>
          <p className="mt-0.5 text-xs text-ink-mute">{label}</p>
        </div>
      ))}
    </div>
  );
}

function StepSummary({
  csv,
  meta,
  onConfirm,
  onBack,
}: {
  csv: ParsedCSV;
  meta: WizardMeta;
  onConfirm: () => void;
  onBack: () => void;
}) {
  const [preflight, setPreflight] = useState<PreflightResult | null>(null);
  const [companyPreflight, setCompanyPreflight] = useState<PreflightResult | null>(null);
  const [preflightLoading, setPreflightLoading] = useState(true);
  const [preflightErr, setPreflightErr] = useState<string | null>(null);
  const [emptyRowCount, setEmptyRowCount] = useState<number | null>(null);

  const columnMap: Record<string, string> = {};
  for (const m of meta.columnMappings) {
    if (m.supabaseField && m.supabaseField !== "ignore") {
      columnMap[m.csvHeader] = m.supabaseField;
    }
  }

  const companyColumnMap: Record<string, string> = {};
  if (meta.companySyncEnabled) {
    for (const m of meta.companyColumnMappings) {
      if (m.supabaseField && m.supabaseField !== "ignore") {
        companyColumnMap[m.csvHeader] = m.supabaseField;
      }
    }
  }

  function toIdentityRecords(mapped: Record<string, unknown>[]) {
    return mapped.map((r) => {
      const rec: Record<string, string> = {};
      for (const f of ["domain", "website_url", "linkedin_url", "email"] as const) {
        if (typeof r[f] === "string" && r[f]) rec[f] = r[f] as string;
      }
      return rec;
    });
  }

  const runPreflight = useCallback(() => {
    setPreflightLoading(true);
    setPreflightErr(null);

    // BUG B: send ONE identity record per mapped row (each carrying that row's
    // domain/website/linkedin/email together) instead of two flat domain and
    // linkedin arrays. The old flat-array approach turned a single company row
    // that had both a domain and a linkedin into TWO separate records, so the
    // preflight dedupe/partition counted it twice and the preview numbers came
    // out ~2x. One record per row makes preflight count the same unit that the
    // real push (`pushRecords`) does. Only identity-relevant fields are sent to
    // keep the payload small.
    const { rows } = parseCSV(csv.allText);
    const mapped = applyColumnMap(rows, columnMap, meta.targetTable);
    setEmptyRowCount(rows.length - mapped.length);
    const identityRecords = toIdentityRecords(mapped);

    const primaryReq = fetch("/api/import/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        records: identityRecords,
        rowCount: mapped.length,
        targetTable: meta.targetTable,
      }),
    }).then(async (r) => {
      const data = await r.json();
      if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
      setPreflight(data as PreflightResult);
    });

    // When the "also contains company data" toggle is on, run a SECOND
    // preflight against the embedded company columns from the SAME rows so
    // the user sees both previews before confirming the (two-stage) push.
    const companyReq = meta.companySyncEnabled
      ? (() => {
          const companyMapped = applyColumnMap(rows, companyColumnMap, "companies");
          const companyIdentityRecords = toIdentityRecords(companyMapped);
          return fetch("/api/import/preflight", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              records: companyIdentityRecords,
              rowCount: companyMapped.length,
              targetTable: "companies",
            }),
          }).then(async (r) => {
            const data = await r.json();
            if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
            setCompanyPreflight(data as PreflightResult);
          });
        })()
      : Promise.resolve();

    Promise.all([primaryReq, companyReq])
      .catch((e) => setPreflightErr(e.message ?? "Preflight failed"))
      .finally(() => setPreflightLoading(false));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { runPreflight(); }, [runPreflight]);

  const tags = [meta.client, meta.niche, meta.date];

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-base font-semibold text-ink">Pre-push Summary</h3>
        <p className="mt-1 text-sm text-ink-soft">Review the dry-run counts before importing.</p>
      </div>

      {/* Record count breakdown */}
      {preflightLoading ? (
        <div className="flex items-center gap-3 rounded-lg border border-rule bg-paper px-4 py-5 text-sm text-ink-mute">
          <Loader2 size={16} className="animate-spin shrink-0" />
          Running preflight check against Supabase…
        </div>
      ) : preflightErr ? (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-red-500" />
          <div className="flex-1">
            <p className="text-sm text-red-700">{preflightErr}</p>
          </div>
          <button
            onClick={runPreflight}
            className="ml-2 flex items-center gap-1 rounded text-xs text-red-600 hover:text-red-800"
          >
            <RefreshCw size={12} /> Retry
          </button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          {meta.companySyncEnabled && companyPreflight && (
            <div className="flex flex-col gap-2">
              <p className="text-xs font-medium text-ink-soft uppercase tracking-wide">Companies</p>
              <PreflightStatGrid preflight={companyPreflight} />
            </div>
          )}
          {preflight && (
            <div className="flex flex-col gap-2">
              {meta.companySyncEnabled && (
                <p className="text-xs font-medium text-ink-soft uppercase tracking-wide">People</p>
              )}
              <PreflightStatGrid preflight={preflight} />
            </div>
          )}
        </div>
      )}

      {!preflightLoading && !preflightErr && emptyRowCount !== null && emptyRowCount > 0 && (
        <p className="text-xs text-ink-mute">
          {emptyRowCount.toLocaleString()} of {(emptyRowCount + (preflight?.inputCount ?? 0)).toLocaleString()} rows have no usable data for the mapped fields and will be skipped.
        </p>
      )}

      {/* Tags to be applied */}
      <div className="rounded-lg border border-rule bg-paper px-4 py-3">
        <p className="mb-1.5 text-xs font-medium text-ink-soft uppercase tracking-wide">Tags to apply</p>
        <div className="flex flex-wrap gap-2">
          {tags.map((tag, i) => (
            <span key={i} className="rounded-full border border-rule bg-hover px-2.5 py-0.5 text-xs font-medium text-ink">
              {tag}
            </span>
          ))}
        </div>
      </div>

      <div className="flex justify-between">
        <button onClick={onBack} className="rounded-lg border border-rule px-4 py-2 text-sm text-ink-soft hover:bg-hover transition-colors">
          Back
        </button>
        <button
          disabled={preflightLoading || !!preflightErr}
          onClick={onConfirm}
          className="rounded-lg bg-stamp px-5 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40 transition-opacity"
        >
          Confirm Push
        </button>
      </div>
    </div>
  );
}

const PHASE_LABELS: Record<string, string> = {
  normalizing: "Normalizing records…",
  preflight: "Checking existing records…",
  partitioning: "Partitioning insert / update…",
  inserting: "Inserting new records…",
  updating: "Updating existing records…",
  done: "Done!",
  error: "Error",
};

function StepProgress({
  progress,
  uploadNote,
  stageLabel,
}: {
  progress: PushProgress | null;
  uploadNote?: string | null;
  stageLabel?: string | null;
}) {
  const phase = progress?.phase ?? "normalizing";
  const pct =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : 0;

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-base font-semibold text-ink">Importing…</h3>
        <p className="mt-1 text-sm text-ink-soft">Please keep this tab open.</p>
        {stageLabel && (
          <p className="mt-2 text-xs font-medium uppercase tracking-wide text-stamp">{stageLabel}</p>
        )}
        {uploadNote && (
          <p className="mt-2 text-sm text-stamp">{uploadNote}</p>
        )}
      </div>

      <div className="flex flex-col gap-4">
        {["normalizing", "preflight", "partitioning", "inserting", "updating", "done"].map((p) => {
          const phases = ["normalizing", "preflight", "partitioning", "inserting", "updating", "done"];
          const currentIdx = phases.indexOf(phase);
          const thisIdx = phases.indexOf(p);
          const isDone = thisIdx < currentIdx || phase === "done";
          const isCurrent = p === phase && phase !== "done";

          return (
            <div key={p} className="flex items-center gap-3">
              <div className={cn(
                "flex h-6 w-6 shrink-0 items-center justify-center rounded-full",
                isDone ? "bg-green-500" : isCurrent ? "bg-stamp" : "bg-rule"
              )}>
                {isDone ? (
                  <CheckCircle size={14} className="text-white" />
                ) : isCurrent ? (
                  <Loader2 size={14} className="text-white animate-spin" />
                ) : (
                  <span className="text-xs text-ink-mute">{thisIdx + 1}</span>
                )}
              </div>
              <span className={cn(
                "text-sm",
                isDone ? "text-ink" : isCurrent ? "font-medium text-ink" : "text-ink-mute"
              )}>
                {PHASE_LABELS[p]}
              </span>
              {isCurrent && progress && progress.total > 0 && (
                <span className="ml-auto text-xs text-ink-mute">
                  {progress.done.toLocaleString()} / {progress.total.toLocaleString()}
                </span>
              )}
            </div>
          );
        })}
      </div>

      {progress && progress.total > 0 && (
        <div className="h-2 w-full rounded-full bg-rule overflow-hidden">
          <div
            className="h-full rounded-full bg-stamp transition-all duration-300"
            style={{ width: `${pct}%` }}
          />
        </div>
      )}
    </div>
  );
}

function ResultStatGrid({ result }: { result: PushResult }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {[
        { label: "Input", value: result.inputCount, color: "text-ink" },
        { label: "Inserted", value: result.insertedCount, color: "text-green-600" },
        { label: "Updated", value: result.updatedCount, color: "text-blue-600" },
        { label: "Failed", value: result.failedCount, color: result.failedCount > 0 ? "text-red-500" : "text-ink-mute" },
      ].map(({ label, value, color }) => (
        <div key={label} className="rounded-lg border border-rule bg-paper px-4 py-3 text-center">
          <p className={cn("text-2xl font-bold tabular-nums", color)}>{value.toLocaleString()}</p>
          <p className="mt-0.5 text-xs text-ink-mute">{label}</p>
        </div>
      ))}
    </div>
  );
}

// A handful of one-off failures (a bad row here or there) aren't worth
// interrupting the user over — the download-CSV link already covers that.
// This is for the case a meaningful chunk of the batch didn't make it in,
// where the person importing needs to know *why* in plain language before
// they decide whether to fix the file and re-run.
const SIGNIFICANT_FAILURE_MIN_COUNT = 10;
const SIGNIFICANT_FAILURE_MIN_RATIO = 0.1;

function isSignificantFailure(failedCount: number, inputCount: number): boolean {
  if (failedCount < SIGNIFICANT_FAILURE_MIN_COUNT) return false;
  return failedCount / Math.max(inputCount, 1) >= SIGNIFICANT_FAILURE_MIN_RATIO;
}

function FailureSummaryBanner({ result }: { result: PushResult }) {
  if (!isSignificantFailure(result.failedCount, result.inputCount)) return null;

  const reasons = summarizeFailures(result.failedRecords);

  return (
    <div className="flex items-start gap-3 rounded-lg border border-red-500/30 bg-red-500/5 px-4 py-3">
      <AlertCircle size={18} className="mt-0.5 shrink-0 text-red-500" />
      <div className="flex flex-col gap-1.5">
        <p className="text-sm font-medium text-ink">
          {result.failedCount.toLocaleString()} of {result.inputCount.toLocaleString()} records
          didn&apos;t import.
        </p>
        <ul className="flex flex-col gap-0.5 text-sm text-ink-soft">
          {reasons.map((r) => (
            <li key={r.message}>
              {r.message} <span className="text-ink-mute">({r.count.toLocaleString()} records)</span>
            </li>
          ))}
        </ul>
        <p className="text-xs text-ink-mute">
          Download the failed records below, fix the issue in your file, and re-import them.
        </p>
      </div>
    </div>
  );
}

function StepReport({
  result,
  companyResult,
  onReset,
}: {
  result: PushResult;
  // Present only for a two-stage (company-sync) import — when set, both
  // stages' results are shown side by side instead of just `result`.
  companyResult?: PushResult | null;
  onReset: () => void;
}) {
  const combinedInput = result.inputCount + (companyResult?.inputCount ?? 0);

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <CheckCircle size={24} className="text-green-500 shrink-0" />
        <div>
          <h3 className="text-base font-semibold text-ink">Import Complete</h3>
          <p className="text-sm text-ink-soft">{combinedInput.toLocaleString()} records processed.</p>
        </div>
      </div>

      {companyResult && (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-ink-soft uppercase tracking-wide">Companies</p>
          <ResultStatGrid result={companyResult} />
          <FailureSummaryBanner result={companyResult} />
          {companyResult.failedCount > 0 && (
            <button
              onClick={() => downloadFailedCsv(companyResult.failedRecords, "import_failed_companies.csv")}
              className="flex items-center gap-2 self-start rounded-lg border border-rule px-4 py-2 text-sm text-ink hover:bg-hover transition-colors"
            >
              <Download size={14} />
              Download failed company records ({companyResult.failedCount})
            </button>
          )}
        </div>
      )}

      <div className="flex flex-col gap-2">
        {companyResult && (
          <p className="text-xs font-medium text-ink-soft uppercase tracking-wide">People</p>
        )}
        <ResultStatGrid result={result} />
        <FailureSummaryBanner result={result} />
        {result.failedCount > 0 && (
          <button
            onClick={() =>
              downloadFailedCsv(
                result.failedRecords,
                companyResult ? "import_failed_people.csv" : "import_failed.csv"
              )
            }
            className="flex items-center gap-2 self-start rounded-lg border border-rule px-4 py-2 text-sm text-ink hover:bg-hover transition-colors"
          >
            <Download size={14} />
            Download failed records ({result.failedCount})
          </button>
        )}
      </div>

      <button
        onClick={onReset}
        className="self-start rounded-lg bg-stamp px-5 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
      >
        Import Another
      </button>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// History tab
// ────────────────────────────────────────────────────────────────────────────

function csvCellValue(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "");
}

function downloadFailedCsv(records: Record<string, unknown>[], filename = "failed_records.csv") {
  if (!records.length) return;
  // Collect the union of keys across every row (rows can have different shapes —
  // e.g. a synthetic `_import_error` marker), not just the first row's keys, so
  // no column is silently dropped. Surface the diagnostic columns first so the
  // reason a row failed is immediately visible instead of buried at the end.
  const seen = new Set<string>();
  for (const r of records) for (const k of Object.keys(r)) seen.add(k);
  const priority = ["_failure_reason", "_import_error", "_partial"];
  const headers = [
    ...priority.filter((k) => seen.has(k)),
    ...[...seen].filter((k) => !priority.includes(k)),
  ];
  const lines = [
    headers.join(","),
    ...records.map((r) =>
      headers.map((h) => {
        const v = csvCellValue(r[h]);
        return v.includes(",") || v.includes('"') || v.includes("\n")
          ? `"${v.replace(/"/g, '""')}"`
          : v;
      }).join(",")
    ),
  ];
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function HistoryTab() {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [failedRecordsById, setFailedRecordsById] = useState<Record<string, Record<string, unknown>[]>>({});
  const [failedRecordsLoading, setFailedRecordsLoading] = useState<string | null>(null);

  function toggleExpanded(id: string) {
    const next = expanded === id ? null : id;
    setExpanded(next);
    if (next && !failedRecordsById[next]) {
      setFailedRecordsLoading(next);
      fetch(`/api/import/history/${next}`)
        .then((r) => r.json())
        .then((data: { failed_records?: Record<string, unknown>[] }) => {
          setFailedRecordsById((prev) => ({ ...prev, [next]: data.failed_records ?? [] }));
        })
        .catch(() => setFailedRecordsById((prev) => ({ ...prev, [next]: [] })))
        .finally(() => setFailedRecordsLoading(null));
    }
  }

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch("/api/import/history")
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
        if (Array.isArray(data)) {
          setRows(data);
        } else {
          throw new Error(data.error ?? "Failed to load history");
        }
      })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={20} className="animate-spin text-ink-mute" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center gap-2 rounded-lg border border-rule bg-paper px-4 py-3 text-sm text-red-500">
        <AlertCircle size={16} />
        {error}
      </div>
    );
  }

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 py-16 text-ink-mute">
        <History size={32} />
        <p className="text-sm">No imports yet. Complete a push to see history here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0 overflow-hidden rounded-lg border border-rule">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-rule bg-hover">
            {["Date", "Provider", "Table", "Tags", "Inserted", "Updated", "Failed"].map((h) => (
              <th key={h} className="px-4 py-2.5 text-left text-xs font-medium text-ink-soft">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-rule">
          {rows.map((row) => {
            const isExpanded = expanded === row.id;
            const hasFailures = row.failed_count > 0;
            const rowFailedRecords = failedRecordsById[row.id];
            const absoluteDate = formatAbsoluteDateTime(row.completed_at ?? row.started_at);
            const relativeDate = timeAgo(row.completed_at ?? row.started_at);

            return (
              <React.Fragment key={row.id}>
                <tr
                  onClick={() => hasFailures && toggleExpanded(row.id)}
                  className={cn(
                    "bg-paper transition-colors",
                    hasFailures ? "cursor-pointer hover:bg-hover" : ""
                  )}
                >
                  <td className="px-4 py-2.5 text-xs text-ink-mute" title={absoluteDate}>
                    {relativeDate}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-ink">{row.display_name}</td>
                  <td className="px-4 py-2.5">
                    <span className={cn(
                      "inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium",
                      row.target_table === "companies"
                        ? "bg-blue-100 text-blue-700"
                        : "bg-purple-100 text-purple-700"
                    )}>
                      {row.target_table === "companies" ? "Companies" : "People"}
                    </span>
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {(row.tags ?? []).map((tag, i) => (
                        <span
                          key={i}
                          className="rounded-full border border-rule bg-hover px-2 py-0.5 text-[10px] text-ink-soft"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 text-sm text-green-600 font-medium tabular-nums">
                    {row.inserted_count.toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-sm text-blue-600 font-medium tabular-nums">
                    {row.updated_count.toLocaleString()}
                  </td>
                  <td className="px-4 py-2.5 text-sm font-medium tabular-nums">
                    <div className="flex items-center gap-1.5">
                      <span className={row.failed_count > 0 ? "text-red-500" : "text-ink-mute"}>
                        {row.failed_count.toLocaleString()}
                      </span>
                      {hasFailures && (
                        <ChevronRight
                          size={12}
                          className={cn(
                            "text-ink-mute transition-transform",
                            isExpanded && "rotate-90"
                          )}
                        />
                      )}
                    </div>
                  </td>
                </tr>
                {isExpanded && hasFailures && (
                  <tr className="bg-red-50/50">
                    <td colSpan={7} className="px-4 py-3">
                      {failedRecordsLoading === row.id || !rowFailedRecords ? (
                        <div className="flex items-center gap-2 py-2 text-xs text-red-600">
                          <Loader2 size={14} className="animate-spin" />
                          Loading failed records…
                        </div>
                      ) : (
                        <div className="flex flex-col gap-3">
                          <div className="flex items-center justify-between">
                            <p className="text-xs font-medium text-red-700">
                              {row.failed_count} failed record{row.failed_count !== 1 ? "s" : ""}
                            </p>
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                downloadFailedCsv(
                                  rowFailedRecords,
                                  `failed_${row.source_key}_${row.id.slice(0, 8)}.csv`
                                );
                              }}
                              className="flex items-center gap-1.5 rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 transition-colors"
                            >
                              <Download size={12} />
                              Download failed records (.csv)
                            </button>
                          </div>
                          <div className="overflow-x-auto rounded-lg border border-red-200">
                            <table className="min-w-full text-xs">
                              <thead>
                                <tr className="border-b border-red-200 bg-red-50">
                                  {Object.keys(rowFailedRecords[0] ?? {}).map((h) => (
                                    <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium text-red-700">
                                      {h}
                                    </th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-red-100">
                                {rowFailedRecords.slice(0, 20).map((rec, i) => (
                                  <tr key={i} className="bg-white">
                                    {Object.keys(rowFailedRecords[0] ?? {}).map((h) => (
                                      <td key={h} className="max-w-[200px] truncate whitespace-nowrap px-3 py-2 text-ink-mute">
                                        {String(rec[h] ?? "") || <span className="text-rule">—</span>}
                                      </td>
                                    ))}
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                            {rowFailedRecords.length > 20 && (
                              <p className="border-t border-red-100 px-3 py-2 text-xs text-red-500">
                                Showing 20 of {rowFailedRecords.length} — download for full list
                              </p>
                            )}
                          </div>
                        </div>
                      )}
                    </td>
                  </tr>
                )}
              </React.Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────────────
// Wizard shell
// ────────────────────────────────────────────────────────────────────────────

type Step = "upload" | "mapping" | "metadata" | "summary" | "progress" | "report";

// Vercel Route Handlers on the Hobby tier cap request bodies at ~4.5MB.
// Above this threshold we relay the CSV through Supabase Storage instead of
// posting it directly, so the upload bypasses the Vercel function entirely.
const DIRECT_UPLOAD_MAX_BYTES = 4 * 1024 * 1024;

const STEPS: Step[] = ["upload", "mapping", "metadata", "summary", "progress", "report"];
const STEP_LABELS: Record<Step, string> = {
  upload: "Upload",
  mapping: "Columns",
  metadata: "Tags",
  summary: "Review",
  progress: "Importing",
  report: "Done",
};

export default function ImportPage() {
  const [activeTab, setActiveTab] = useState<"import" | "history">("import");
  const [step, setStep] = useState<Step>("upload");

  const [csv, setCsv] = useState<ParsedCSV | null>(null);
  const [meta, setMeta] = useState<WizardMeta>({
    provider: null,
    customSourceKey: "manual-csv",
    targetTable: "companies",
    columnMappings: [],
    companySyncEnabled: false,
    companyColumnMappings: [],
    client: "",
    niche: "",
    date: new Date().toISOString().slice(0, 10),
  });

  const [progress, setProgress] = useState<PushProgress | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [result, setResult] = useState<PushResult | null>(null);
  // Only set for a two-stage (company-sync) import — the companies stage's
  // result, shown alongside `result` (the people stage) in the final report.
  const [companyResult, setCompanyResult] = useState<PushResult | null>(null);
  const [stageLabel, setStageLabel] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);


  const reset = useCallback(() => {
    setCsv(null);
    setMeta({
      provider: null,
      customSourceKey: "manual-csv",
      targetTable: "companies",
      columnMappings: [],
      companySyncEnabled: false,
      companyColumnMappings: [],
      client: "",
      niche: "",
      date: new Date().toISOString().slice(0, 10),
    });
    setProgress(null);
    setUploadNote(null);
    setResult(null);
    setCompanyResult(null);
    setStageLabel(null);
    setErrorMsg(null);
    setStep("upload");
  }, []);

  // Runs ONE push (one target table, one column map) against the existing
  // single-target `/api/import/stream` endpoint end-to-end: filters empty
  // rows, uploads (direct or via storage relay for large files), and drains
  // the SSE stream to its terminal `done`/`error` event. Used directly for a
  // normal single-target import, and called TWICE in sequence (companies
  // then people) for a company-sync import — see `runImport` below. Reused
  // as-is between both call sites; the only difference between them is which
  // `targetTable`/`columnMap`/`sourceKey` gets passed in.
  async function pushTarget({
    headers,
    rows,
    columnMap,
    targetTable,
    sourceKey,
    tags,
  }: {
    headers: string[];
    rows: Record<string, string>[];
    columnMap: Record<string, string>;
    targetTable: TargetTable;
    sourceKey: string;
    tags: [string, string, string];
  }): Promise<PushResult> {
    const metadata = { targetTable, sourceKey, tags, columnMap };

    // Filter out rows that would be discarded server-side anyway (no
    // populated identity field after mapping) so we don't waste upload
    // payload size on rows that can never survive `applyColumnMap`.
    // BUG D: pass the target so people rows with only a company_name are treated
    // as empty here too (kept consistent with the server's applyColumnMap).
    const nonEmptyRows = filterMappedNonEmptyRows(rows, columnMap, targetTable);
    const filteredText = serializeCSV(headers, nonEmptyRows);
    const byteLength = new TextEncoder().encode(filteredText).length;

    let response: Response;

    if (byteLength > DIRECT_UPLOAD_MAX_BYTES) {
      setUploadNote(
        "Large file detected — uploading via secure storage, this may take a bit longer."
      );

      try {
        const signRes = await fetch("/api/import/storage-upload", {
          method: "POST",
        });

        if (!signRes.ok) {
          const text = await signRes.text();
          throw new Error(text || `HTTP ${signRes.status}`);
        }

        const { path, signedUrl } = (await signRes.json()) as {
          path: string;
          token: string;
          signedUrl: string;
        };

        // Mirrors the wire format used by supabase-js's
        // `uploadToSignedUrl` (PUT with a multipart body containing an
        // empty-named file field). We hit the signed URL directly with
        // fetch instead of instantiating a Supabase client, since we have
        // no anon/public key to give a browser-side client and the token
        // embedded in the signed URL (already appended server-side by
        // `createSignedUploadUrl`) is all the auth this endpoint needs.
        const uploadBody = new FormData();
        uploadBody.append("cacheControl", "3600");
        uploadBody.append("", new Blob([filteredText], { type: "text/csv" }));

        const uploadRes = await fetch(signedUrl, {
          method: "PUT",
          body: uploadBody,
        });

        if (!uploadRes.ok) {
          const text = await uploadRes.text();
          throw new Error(text || `Storage upload failed: HTTP ${uploadRes.status}`);
        }

        response = await fetch("/api/import/stream", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ path, metadata: JSON.stringify(metadata) }),
        });
      } finally {
        setUploadNote(null);
      }
    } else {
      const formData = new FormData();
      const blob = new Blob([filteredText], { type: "text/csv" });
      formData.append("file", blob, "import.csv");
      formData.append("metadata", JSON.stringify(metadata));

      response = await fetch("/api/import/stream", {
        method: "POST",
        body: formData,
      });
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || `HTTP ${response.status}`);
    }

    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        let event: { phase: string; done?: number; total?: number; message?: string; result?: PushResult };
        try {
          event = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
        if (event.phase === "error") {
          throw new Error(event.message ?? "Unknown error");
        }
        if (event.phase === "done" && event.result) {
          return event.result;
        }
        setProgress(event as PushProgress);
      }
    }

    throw new Error("Import stream ended unexpectedly without a result");
  }

  async function runImport(finalMeta: WizardMeta, csvData: ParsedCSV) {
    setStep("progress");
    setCompanyResult(null);
    setStageLabel(null);


    const { headers, rows } = parseCSV(csvData.allText);
    const tags = [finalMeta.client, finalMeta.niche, finalMeta.date] as [string, string, string];
    const sourceKey = finalMeta.provider?.sourceKey ?? finalMeta.customSourceKey;

    const personColumnMap: Record<string, string> = {};
    for (const m of finalMeta.columnMappings) {
      if (m.supabaseField && m.supabaseField !== "ignore") {
        personColumnMap[m.csvHeader] = m.supabaseField;
      }
    }

    try {
      if (finalMeta.companySyncEnabled) {
        // Two-stage push: companies MUST finish (fully committed to the DB)
        // before people starts, since the people push's own domain-based
        // company_id lookup (fetchCompanyIdByDomain in lib/import/push.ts)
        // re-queries the companies table fresh at push time — no separate
        // linking step needed as long as this ordering holds.
        const companyColumnMap: Record<string, string> = {};
        for (const m of finalMeta.companyColumnMappings) {
          if (m.supabaseField && m.supabaseField !== "ignore") {
            companyColumnMap[m.csvHeader] = m.supabaseField;
          }
        }

        setStageLabel("Stage 1 of 2: Companies");
        setProgress(null);
        const companiesResult = await pushTarget({
          headers,
          rows,
          columnMap: companyColumnMap,
          targetTable: "companies",
          sourceKey,
          tags,
        });
        setCompanyResult(companiesResult);

        setStageLabel("Stage 2 of 2: People");
        setProgress(null);
        const peopleResult = await pushTarget({
          headers,
          rows,
          columnMap: personColumnMap,
          targetTable: "people",
          sourceKey,
          tags,
        });

        setResult(peopleResult);
        setStep("report");
      } else {
        const singleResult = await pushTarget({
          headers,
          rows,
          columnMap: personColumnMap,
          targetTable: finalMeta.targetTable,
          sourceKey,
          tags,
        });
        setResult(singleResult);
        setStep("report");
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Unknown error");
      setStep("report");
    }
  }

  const currentStepIdx = STEPS.indexOf(step);

  return (
    <>
      <AppShell>
        <Topbar section="Data" page="Import" />

        <main className="flex-1 overflow-x-hidden overflow-y-auto px-5 py-6 md:px-7">
          <div className="mx-auto max-w-3xl">
            {/* Tab bar */}
            <div className="mb-6 flex gap-1 rounded-lg border border-rule bg-paper p-1">
              {(["import", "history"] as const).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setActiveTab(tab)}
                  className={cn(
                    "flex flex-1 items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors",
                    activeTab === tab
                      ? "bg-hover text-ink shadow-sm"
                      : "text-ink-soft hover:text-ink"
                  )}
                >
                  {tab === "import" ? <Upload size={14} /> : <History size={14} />}
                  {tab === "import" ? "Import" : "History"}
                </button>
              ))}
            </div>

            {activeTab === "history" ? (
              <HistoryTab key={activeTab} />
            ) : (
              <div className="rounded-xl border border-rule bg-card overflow-hidden">
                {/* Step breadcrumb */}
                {step !== "progress" && step !== "report" && (
                  <div className="border-b border-rule px-6 py-3">
                    <div className="flex items-center gap-1 text-xs">
                      {(["upload", "mapping", "metadata", "summary"] as Step[]).map((s, i) => {
                        const idx = STEPS.indexOf(s);
                        const done = idx < currentStepIdx;
                        const active = s === step;
                        return (
                          <span key={s} className="flex items-center gap-1">
                            {i > 0 && <ChevronRight size={12} className="text-ink-mute" />}
                            <span className={cn(
                              done ? "text-stamp" : active ? "font-medium text-ink" : "text-ink-mute"
                            )}>
                              {STEP_LABELS[s]}
                            </span>
                          </span>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="p-6">
                  {step === "upload" && (
                    <StepUpload
                      onNext={(parsedCsv, provider, sourceKey, targetTable, companySyncEnabled) => {
                        setCsv(parsedCsv);
                        const providerMap =
                          provider && targetTable !== provider.targetTable
                            ? provider.altColumnMap ?? {}
                            : provider?.columnMap ?? {};
                        const mappings = autoMapColumns(
                          parsedCsv.headers,
                          providerMap,
                          targetTable
                        );
                        const companyMappings = companySyncEnabled
                          ? autoMapColumns(parsedCsv.headers, provider?.companyColumnMap ?? {}, "companies")
                          : [];
                        setMeta((prev) => ({
                          ...prev,
                          provider,
                          customSourceKey: sourceKey,
                          targetTable,
                          columnMappings: mappings,
                          companySyncEnabled,
                          companyColumnMappings: companyMappings,
                        }));
                        setStep("mapping");
                      }}
                    />
                  )}

                  {step === "mapping" && csv && (
                    <StepMapping
                      csv={csv}
                      initialMappings={meta.columnMappings}
                      targetTable={meta.targetTable}
                      sourceKey={meta.provider?.sourceKey ?? meta.customSourceKey}
                      companySyncEnabled={meta.companySyncEnabled}
                      initialCompanyMappings={meta.companyColumnMappings}
                      onNext={(mappings, companyMappings) => {
                        setMeta((prev) => ({
                          ...prev,
                          columnMappings: mappings,
                          companyColumnMappings: companyMappings,
                        }));
                        setStep("metadata");
                      }}
                      onBack={() => setStep("upload")}
                    />
                  )}

                  {step === "metadata" && (
                    <StepMetadata
                      defaultClient={meta.client}
                      defaultNiche={meta.niche}
                      onNext={(client, niche, date) => {
                        const updatedMeta = { ...meta, client, niche, date };
                        setMeta(updatedMeta);
                        setStep("summary");
                      }}
                      onBack={() => setStep("mapping")}
                    />
                  )}

                  {step === "summary" && csv && (
                    <StepSummary
                      csv={csv}
                      meta={meta}
                      onConfirm={() => runImport(meta, csv)}
                      onBack={() => setStep("metadata")}
                    />
                  )}

                  {step === "progress" && (
                    <StepProgress progress={progress} uploadNote={uploadNote} stageLabel={stageLabel} />
                  )}

                  {step === "report" && (
                    errorMsg ? (
                      <div className="flex flex-col gap-4">
                        <div className="flex items-center gap-3">
                          <AlertCircle size={24} className="text-red-500 shrink-0" />
                          <div>
                            <h3 className="text-base font-semibold text-ink">Import Failed</h3>
                            <p className="text-sm text-ink-soft">{errorMsg}</p>
                          </div>
                        </div>
                        <button onClick={reset} className="self-start rounded-lg border border-rule px-4 py-2 text-sm text-ink hover:bg-hover transition-colors">
                          Try Again
                        </button>
                      </div>
                    ) : result ? (
                      <StepReport result={result} companyResult={companyResult} onReset={reset} />
                    ) : null
                  )}
                </div>
              </div>
            )}
          </div>
        </main>
      </AppShell>
    </>
  );
}
