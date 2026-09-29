"use client";

import { useEffect, useRef, useState } from "react";
import { AlertCircle, Download, Inbox, Loader2 } from "lucide-react";
import { cn, formatAbsoluteDateTime, timeAgo } from "@/lib/utils";
import { summarizeFailures } from "@/lib/import/failure-messages";
import type { ImportJobStatus, ImportJobSummary, ImportStageResult } from "@/lib/data/import-jobs";

// ────────────────────────────────────────────────────────────────────────────
// Result pieces (shared with the History tab in page.tsx)
// ────────────────────────────────────────────────────────────────────────────

/** The counts a result grid / failure banner needs — one stage's outcome. */
interface StageCounts {
  inputCount: number;
  insertedCount: number;
  updatedCount: number;
  failedCount: number;
}

function ResultStatGrid({ result }: { result: StageCounts }) {
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

function FailureSummaryBanner({
  result,
  failedRecords,
}: {
  result: StageCounts;
  failedRecords: Record<string, unknown>[];
}) {
  if (!isSignificantFailure(result.failedCount, result.inputCount)) return null;

  const reasons = summarizeFailures(failedRecords);

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
          Download the failed records, fix the issue in your file, and re-import them.
        </p>
      </div>
    </div>
  );
}

function csvCellValue(v: unknown): string {
  return typeof v === "object" && v !== null ? JSON.stringify(v) : String(v ?? "");
}

export function downloadFailedCsv(records: Record<string, unknown>[], filename = "failed_records.csv") {
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

// ────────────────────────────────────────────────────────────────────────────
// Queue view
// ────────────────────────────────────────────────────────────────────────────

const STATUS_LABELS: Record<ImportJobStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  partial: "Partial",
  canceled: "Canceled",
};

const STATUS_BADGE: Record<ImportJobStatus, string> = {
  queued: "bg-rule/50 text-ink-soft",
  running: "bg-stamp/15 text-stamp",
  succeeded: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  partial: "bg-warning/15 text-warning",
  canceled: "bg-rule/50 text-ink-soft",
};

const TABLE_LABELS = { companies: "Companies", people: "People" } as const;

/** "Stage 1 of 2: Companies" for a company-sync job, plain "People" otherwise. */
function stageLabel(job: ImportJobSummary): string {
  const stageIdx = Math.min(job.cursor?.stage ?? 0, job.stages.length - 1);
  const stage = job.stages[stageIdx];
  if (!stage) return "";
  const table = TABLE_LABELS[stage.targetTable];
  return job.stages.length > 1 ? `Stage ${stageIdx + 1} of ${job.stages.length}: ${table}` : table;
}

function ProgressBar({ processed, total }: { processed: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between text-xs text-ink-soft">
        <span>
          {processed.toLocaleString("en-US")} / {total.toLocaleString("en-US")}
        </span>
        <span className="font-medium text-ink">{pct}%</span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-hover">
        <div
          className="h-full rounded-full bg-stamp transition-[width] duration-500"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function toCounts(r: ImportStageResult): StageCounts {
  return {
    inputCount: r.inputCount,
    insertedCount: r.inserted,
    updatedCount: r.updated,
    failedCount: r.failed,
  };
}

/** One finished stage: stat grid, failure summary, and the lazy failed-records
 * download. The records come from the stage's import_history row (uncapped
 * per-stage, and the only place an earlier stage's failures survive); the
 * job's own capped list is the fallback for the last stage if no history row
 * was written. */
function StageResult({
  job,
  stage,
  index,
}: {
  job: ImportJobSummary;
  stage: ImportStageResult;
  index: number;
}) {
  const [records, setRecords] = useState<Record<string, unknown>[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const counts = toCounts(stage);
  const isLastStage = index === job.stages.length - 1;

  async function load(): Promise<Record<string, unknown>[] | null> {
    if (records) return records;
    setLoading(true);
    setLoadError(null);
    try {
      const url = stage.historyId
        ? `/api/import/history/${stage.historyId}`
        : isLastStage
          ? `/api/import-jobs/${job.id}?include=failed`
          : null;
      if (!url) throw new Error("Failed records for this stage are no longer available.");
      const res = await fetch(url, { cache: "no-store" });
      const body = (await res.json()) as { failed_records?: Record<string, unknown>[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const loaded = body.failed_records ?? [];
      setRecords(loaded);
      return loaded;
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Failed to load failed records.");
      return null;
    } finally {
      setLoading(false);
    }
  }

  async function download() {
    const loaded = await load();
    if (!loaded) return;
    downloadFailedCsv(
      loaded,
      `import_failed_${stage.targetTable}_${job.id.slice(0, 8)}.csv`
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {job.stages.length > 1 && (
        <p className="text-xs font-medium text-ink-soft uppercase tracking-wide">
          {TABLE_LABELS[stage.targetTable]}
        </p>
      )}
      <ResultStatGrid result={counts} />
      {records && <FailureSummaryBanner result={counts} failedRecords={records} />}
      {stage.failed > 0 && (
        <>
          <button
            type="button"
            onClick={download}
            disabled={loading}
            className="flex items-center gap-2 self-start rounded-lg border border-rule px-4 py-2 text-sm text-ink hover:bg-hover disabled:opacity-60 transition-colors"
          >
            {loading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
            Download failed records ({stage.failed.toLocaleString()})
          </button>
          {loadError && <p className="text-xs text-red-500">{loadError}</p>}
        </>
      )}
    </div>
  );
}

function JobCard({ job }: { job: ImportJobSummary }) {
  const isTerminal = job.status !== "queued" && job.status !== "running";

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-rule bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">{job.fileName ?? "import.csv"}</span>
          <span className="inline-flex items-center rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-ink">
            {job.sourceKey}
          </span>
          {job.tags
            .filter((t) => t)
            .map((t, i) => (
              <span
                key={`${t}-${i}`}
                className="inline-flex items-center rounded-full border border-rule px-2 py-0.5 text-[11px] text-ink-soft"
              >
                {t}
              </span>
            ))}
        </div>
        <span
          className={cn(
            "inline-flex items-center rounded-full px-2.5 py-0.5 text-[11px] font-medium",
            STATUS_BADGE[job.status]
          )}
        >
          {STATUS_LABELS[job.status]}
        </span>
      </div>

      {job.status === "queued" ? (
        <p className="text-xs text-ink-mute">
          Queued — starts after current import
          {job.rowCount > 0 ? ` · ${job.rowCount.toLocaleString("en-US")} rows` : ""}
        </p>
      ) : job.status === "running" ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium uppercase tracking-wide text-stamp">{stageLabel(job)}</p>
          <ProgressBar processed={job.processed} total={job.total} />
        </div>
      ) : null}

      {isTerminal && (
        <div className="flex flex-col gap-4">
          {job.error && (
            <p className="flex items-start gap-2 text-sm text-danger">
              <AlertCircle size={16} className="mt-0.5 shrink-0" />
              {job.error}
            </p>
          )}
          {job.stageResults.map((stage, i) => (
            <StageResult key={i} job={job} stage={stage} index={i} />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-mute">
        <span>{job.triggeredByEmail ?? "—"}</span>
        <span aria-hidden>·</span>
        <span title={formatAbsoluteDateTime(job.createdAt)}>{timeAgo(job.createdAt)}</span>
      </div>
    </div>
  );
}

export function ImportQueueView() {
  const [rows, setRows] = useState<ImportJobSummary[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestIdRef = useRef(0);

  async function fetchJobs(offset: number) {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/import-jobs?offset=${offset}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load the import queue.");
      if (requestId !== requestIdRef.current) return;

      setRows((prev) => (offset === 0 ? body.rows : [...prev, ...body.rows]));
      setHasMore(Boolean(body.hasMore));
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load the import queue.");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  // Initial page load. Inlined (rather than calling fetchJobs) so no state is
  // set synchronously in the effect body: `loading` already starts true.
  useEffect(() => {
    const requestId = ++requestIdRef.current;
    fetch("/api/import-jobs?offset=0", { cache: "no-store" })
      .then(async (res) => {
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? "Failed to load the import queue.");
        if (requestId !== requestIdRef.current) return;
        setRows(body.rows);
        setHasMore(Boolean(body.hasMore));
      })
      .catch((err) => {
        if (requestId !== requestIdRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to load the import queue.");
      })
      .finally(() => {
        if (requestId === requestIdRef.current) setLoading(false);
      });
  }, []);

  const hasActive = rows.some((r) => r.status === "queued" || r.status === "running");

  // Live poll while any visible job is queued/running, stopping once all are
  // terminal — same request-id-guarded pattern as the Push Activity view.
  // Refetches page 0 and merges by id so live counters advance and freshly-
  // enqueued jobs appear at the top without discarding already "load more"-d
  // pages.
  useEffect(() => {
    if (!hasActive) return;

    async function poll() {
      // Read (don't bump) the request id: a user-initiated fetch increments it
      // and thereby invalidates an in-flight poll, but a poll must never bump
      // it — otherwise a tick firing mid-"Load more" would discard that append.
      const requestId = requestIdRef.current;
      try {
        const res = await fetch("/api/import-jobs?offset=0", { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { rows: ImportJobSummary[] };
        if (requestId !== requestIdRef.current) return;

        setRows((prev) => {
          const updates = new Map(body.rows.map((r) => [r.id, r]));
          const prevIds = new Set(prev.map((r) => r.id));
          const merged = prev.map((r) => updates.get(r.id) ?? r);
          const fresh = body.rows.filter((r) => !prevIds.has(r.id));
          return [...fresh, ...merged];
        });
      } catch {
        // Transient poll failure — the next tick retries; no error banner for
        // a background refresh.
      }
    }

    const interval = setInterval(poll, 1500);
    return () => clearInterval(interval);
  }, [hasActive]);

  if (loading && rows.length === 0) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 size={20} className="animate-spin text-ink-mute" />
      </div>
    );
  }

  if (error && rows.length === 0) {
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
        <Inbox size={32} />
        <p className="text-sm">No imports queued yet. Confirm an import to see it here.</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {rows.map((job) => (
          <JobCard key={job.id} job={job} />
        ))}
      </div>

      {error && <p className="text-center text-xs text-red-500">{error}</p>}

      {hasMore && (
        <button
          type="button"
          onClick={() => fetchJobs(rows.length)}
          disabled={loading}
          className="flex items-center justify-center gap-2 self-center rounded-lg border border-rule bg-card px-4 py-2 text-sm font-medium text-ink transition-opacity hover:opacity-90 disabled:opacity-60"
        >
          {loading && <Loader2 size={15} className="animate-spin" />}
          Load more
        </button>
      )}
    </div>
  );
}
