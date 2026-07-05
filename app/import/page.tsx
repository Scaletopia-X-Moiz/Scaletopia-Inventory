"use client";

import React, { useState, useRef, useCallback, useEffect } from "react";
import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { cn, timeAgo } from "@/lib/utils";
import {
  BUILTIN_PROVIDERS,
  COMPANIES_FIELDS,
  PEOPLE_FIELDS,
  type ProviderPreset,
  type TargetTable,
} from "@/lib/import/providers";
import { fuzzyMatchColumn } from "@/lib/import/normalize";
import { parseCSV, applyColumnMap, filterMappedNonEmptyRows, serializeCSV } from "@/lib/import/csv";
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
  failed_records: Record<string, unknown>[] | null;
  started_at: string;
  completed_at: string | null;
}

const AUTH_KEY = "import_auth";
const IMPORT_TOKEN = "scaletopia-import-2026";

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

  return headers.map((header) => {
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
}

// ────────────────────────────────────────────────────────────────────────────
// Auth gate
// ────────────────────────────────────────────────────────────────────────────

function AuthGate({ onAuth }: { onAuth: () => void }) {
  const [user, setUser] = useState("");
  const [pass, setPass] = useState("");
  const [err, setErr] = useState(false);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (user === "admin" && pass === "admin") {
      sessionStorage.setItem(AUTH_KEY, JSON.stringify({ authed: true, token: IMPORT_TOKEN }));
      onAuth();
    } else {
      setErr(true);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-xl border border-rule bg-card p-8 shadow-xl">
        <h2 className="mb-1 text-lg font-semibold text-ink">Import Access</h2>
        <p className="mb-6 text-sm text-ink-soft">Enter credentials to continue.</p>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <input
            type="text"
            placeholder="Username"
            value={user}
            onChange={(e) => { setUser(e.target.value); setErr(false); }}
            className="rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
            autoFocus
          />
          <input
            type="password"
            placeholder="Password"
            value={pass}
            onChange={(e) => { setPass(e.target.value); setErr(false); }}
            className="rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
          />
          {err && <p className="text-xs text-red-500">Invalid credentials.</p>}
          <button
            type="submit"
            className="rounded-lg bg-stamp px-4 py-2 text-sm font-medium text-white hover:opacity-90 transition-opacity"
          >
            Continue
          </button>
        </form>
      </div>
    </div>
  );
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
  onNext: (csv: ParsedCSV, provider: ProviderPreset | null, customKey: string, targetTable: TargetTable) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const [csv, setCsv] = useState<ParsedCSV | null>(null);
  const [providerKey, setProviderKey] = useState("manual-csv");
  const [targetOverride, setTargetOverride] = useState<TargetTable | "">("");
  const [customProviders, setCustomProviders] = useState<ProviderPreset[]>([]);

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
        onClick={() => csv && onNext(csv, selectedProvider, selectedProvider?.sourceKey ?? "custom", effectiveTable)}
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

function StepMapping({
  csv,
  initialMappings,
  targetTable,
  sourceKey,
  onNext,
  onBack,
}: {
  csv: ParsedCSV;
  initialMappings: ColumnMapping[];
  targetTable: TargetTable;
  sourceKey: string;
  onNext: (mappings: ColumnMapping[]) => void;
  onBack: () => void;
}) {
  const [mappings, setMappings] = useState<ColumnMapping[]>(initialMappings);
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
    onNext(mappings);
  }

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h3 className="text-base font-semibold text-ink">Map Columns</h3>
        <p className="mt-1 text-sm text-ink-soft">
          Match each CSV column to a Supabase field. Ignored columns won&apos;t be imported.
        </p>
      </div>

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
                    {csv.sampleRows[0]?.[m.csvHeader] ?? "—"}
                  </span>
                </td>
                <td className="px-4 py-2.5">
                  <select
                    value={m.supabaseField}
                    onChange={(e) => setField(m.csvHeader, e.target.value)}
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
  const [preflightLoading, setPreflightLoading] = useState(true);
  const [preflightErr, setPreflightErr] = useState<string | null>(null);
  const [emptyRowCount, setEmptyRowCount] = useState<number | null>(null);

  const columnMap: Record<string, string> = {};
  for (const m of meta.columnMappings) {
    if (m.supabaseField && m.supabaseField !== "ignore") {
      columnMap[m.csvHeader] = m.supabaseField;
    }
  }

  const runPreflight = useCallback(() => {
    setPreflightLoading(true);
    setPreflightErr(null);

    // Extract identity fields client-side so we only send small arrays, not the full CSV text
    const { rows } = parseCSV(csv.allText);
    const mapped = applyColumnMap(rows, columnMap);
    setEmptyRowCount(rows.length - mapped.length);
    const domains = mapped.map((r) => r.domain).filter((d): d is string => typeof d === "string" && !!d);
    const linkedins = mapped.map((r) => r.linkedin_url).filter((l): l is string => typeof l === "string" && !!l);

    fetch("/api/import/preflight", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        domains,
        linkedins,
        rowCount: mapped.length,
        targetTable: meta.targetTable,
      }),
    })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
        setPreflight(data as PreflightResult);
      })
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
      ) : preflight ? (
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
      ) : null}

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
}: {
  progress: PushProgress | null;
  uploadNote?: string | null;
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

function StepReport({
  result,
  onReset,
}: {
  result: PushResult;
  onReset: () => void;
}) {
  function downloadFailed() {
    downloadFailedCsv(result.failedRecords, "import_failed.csv");
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex items-center gap-3">
        <CheckCircle size={24} className="text-green-500 shrink-0" />
        <div>
          <h3 className="text-base font-semibold text-ink">Import Complete</h3>
          <p className="text-sm text-ink-soft">{result.inputCount.toLocaleString()} records processed.</p>
        </div>
      </div>

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

      {result.failedCount > 0 && (
        <button
          onClick={downloadFailed}
          className="flex items-center gap-2 self-start rounded-lg border border-rule px-4 py-2 text-sm text-ink hover:bg-hover transition-colors"
        >
          <Download size={14} />
          Download failed records ({result.failedCount})
        </button>
      )}

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
  const headers = Object.keys(records[0]);
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

function HistoryTab({ token }: { token: string }) {
  const [rows, setRows] = useState<HistoryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch("/api/import/history", { headers: { "X-Import-Token": token } })
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
  }, [token]);

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
            const hasFailures = row.failed_count > 0 && (row.failed_records?.length ?? 0) > 0;
            const absoluteDate = row.completed_at
              ? new Date(row.completed_at).toLocaleString()
              : new Date(row.started_at).toLocaleString();
            const relativeDate = timeAgo(row.completed_at ?? row.started_at);

            return (
              <React.Fragment key={row.id}>
                <tr
                  onClick={() => hasFailures && setExpanded(isExpanded ? null : row.id)}
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
                      <div className="flex flex-col gap-3">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-medium text-red-700">
                            {row.failed_count} failed record{row.failed_count !== 1 ? "s" : ""}
                          </p>
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              downloadFailedCsv(
                                row.failed_records!,
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
                                {Object.keys(row.failed_records![0] ?? {}).map((h) => (
                                  <th key={h} className="whitespace-nowrap px-3 py-2 text-left font-medium text-red-700">
                                    {h}
                                  </th>
                                ))}
                              </tr>
                            </thead>
                            <tbody className="divide-y divide-red-100">
                              {row.failed_records!.slice(0, 20).map((rec, i) => (
                                <tr key={i} className="bg-white">
                                  {Object.keys(row.failed_records![0] ?? {}).map((h) => (
                                    <td key={h} className="max-w-[200px] truncate whitespace-nowrap px-3 py-2 text-ink-mute">
                                      {String(rec[h] ?? "") || <span className="text-rule">—</span>}
                                    </td>
                                  ))}
                                </tr>
                              ))}
                            </tbody>
                          </table>
                          {row.failed_records!.length > 20 && (
                            <p className="border-t border-red-100 px-3 py-2 text-xs text-red-500">
                              Showing 20 of {row.failed_records!.length} — download for full list
                            </p>
                          )}
                        </div>
                      </div>
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
  const [authed, setAuthed] = useState(false);
  const [activeTab, setActiveTab] = useState<"import" | "history">("import");
  const [step, setStep] = useState<Step>("upload");

  const [csv, setCsv] = useState<ParsedCSV | null>(null);
  const [meta, setMeta] = useState<WizardMeta>({
    provider: null,
    customSourceKey: "manual-csv",
    targetTable: "companies",
    columnMappings: [],
    client: "",
    niche: "",
    date: new Date().toISOString().slice(0, 10),
  });

  const [progress, setProgress] = useState<PushProgress | null>(null);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  const [result, setResult] = useState<PushResult | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(AUTH_KEY);
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed?.authed && parsed?.token === IMPORT_TOKEN) setAuthed(true);
      }
    } catch {}
  }, []);

  const reset = useCallback(() => {
    setCsv(null);
    setMeta({
      provider: null,
      customSourceKey: "manual-csv",
      targetTable: "companies",
      columnMappings: [],
      client: "",
      niche: "",
      date: new Date().toISOString().slice(0, 10),
    });
    setProgress(null);
    setUploadNote(null);
    setResult(null);
    setErrorMsg(null);
    setStep("upload");
  }, []);

  async function runImport(finalMeta: WizardMeta, csvData: ParsedCSV) {
    setStep("progress");

    const token = (() => {
      try {
        return JSON.parse(sessionStorage.getItem(AUTH_KEY) ?? "{}").token ?? "";
      } catch {
        return "";
      }
    })();

    const columnMap: Record<string, string> = {};
    for (const m of finalMeta.columnMappings) {
      if (m.supabaseField && m.supabaseField !== "ignore") {
        columnMap[m.csvHeader] = m.supabaseField;
      }
    }

    const metadata = {
      targetTable: finalMeta.targetTable,
      sourceKey: finalMeta.provider?.sourceKey ?? finalMeta.customSourceKey,
      tags: [finalMeta.client, finalMeta.niche, finalMeta.date] as [string, string, string],
      columnMap,
    };

    // Filter out rows that would be discarded server-side anyway (no
    // populated identity field after mapping) so we don't waste upload
    // payload size on rows that can never survive `applyColumnMap`.
    const { headers, rows } = parseCSV(csvData.allText);
    const nonEmptyRows = filterMappedNonEmptyRows(rows, columnMap);
    const filteredText = serializeCSV(headers, nonEmptyRows);
    const byteLength = new TextEncoder().encode(filteredText).length;

    try {
      let response: Response;

      if (byteLength > DIRECT_UPLOAD_MAX_BYTES) {
        setUploadNote(
          "Large file detected — uploading via secure storage, this may take a bit longer."
        );

        try {
          const signRes = await fetch("/api/import/storage-upload", {
            method: "POST",
            headers: { "X-Import-Token": token },
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
            headers: { "X-Import-Token": token, "Content-Type": "application/json" },
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
          headers: { "X-Import-Token": token },
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
          try {
            const event = JSON.parse(line.slice(6));
            if (event.phase === "error") {
              setErrorMsg(event.message ?? "Unknown error");
              setStep("report");
              return;
            }
            if (event.phase === "done" && event.result) {
              setResult(event.result);
              setStep("report");
              return;
            }
            setProgress(event as PushProgress);
          } catch {}
        }
      }
    } catch (e) {
      setErrorMsg(e instanceof Error ? e.message : "Unknown error");
      setStep("report");
    }
  }

  const currentStepIdx = STEPS.indexOf(step);

  return (
    <>
      {!authed && <AuthGate onAuth={() => setAuthed(true)} />}
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
              <HistoryTab key={activeTab} token={IMPORT_TOKEN} />
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
                      onNext={(parsedCsv, provider, sourceKey, targetTable) => {
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
                        setMeta((prev) => ({
                          ...prev,
                          provider,
                          customSourceKey: sourceKey,
                          targetTable,
                          columnMappings: mappings,
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
                      onNext={(mappings) => {
                        setMeta((prev) => ({ ...prev, columnMappings: mappings }));
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
                    <StepProgress progress={progress} uploadNote={uploadNote} />
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
                      <StepReport result={result} onReset={reset} />
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
