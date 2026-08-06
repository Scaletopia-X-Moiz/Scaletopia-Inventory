"use client";

import { useEffect, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn, formatAbsoluteDateTime, timeAgo } from "@/lib/utils";
import type { PushJobListRow, PushJobStatus } from "@/lib/data/push-jobs";
import { PushJobDeepLinkButtons } from "@/components/shared/push-job-deep-link-buttons";

/** Client/platform filter idiom mirrors /push-history, but the platform
 * options are push_jobs' granular vocabulary (`platform` distinguishes
 * EmailBison's People/Companies/Campaign surfaces), so filtering by `eq` on
 * the stored value stays exact. */
const PLATFORM_OPTIONS = [
  { value: "ghl", label: "GHL" },
  { value: "emailbison_people", label: "EmailBison · People" },
  { value: "emailbison_companies", label: "EmailBison · Companies" },
  { value: "emailbison_campaign", label: "EmailBison · Campaign" },
];

const STATUS_LABELS: Record<PushJobStatus, string> = {
  queued: "Queued",
  running: "Running",
  succeeded: "Succeeded",
  failed: "Failed",
  partial: "Partial",
  canceled: "Canceled",
};

const STATUS_BADGE: Record<PushJobStatus, string> = {
  queued: "bg-rule/50 text-ink-soft",
  running: "bg-stamp/15 text-stamp",
  succeeded: "bg-success/15 text-success",
  failed: "bg-danger/15 text-danger",
  partial: "bg-warning/15 text-warning",
  canceled: "bg-rule/50 text-ink-soft",
};

/** The push platform, split into the vendor ("GHL"/"EmailBison") and the
 * surface it targeted ("People"/"Companies"/"Campaign") — the vendor is the
 * `platform` prefix, the surface comes from `action`/`entity` (issue #122). */
function describePlatform(job: PushJobListRow): { vendor: string; surface: string } {
  const vendor = job.platform.startsWith("emailbison") ? "EmailBison" : job.platform === "ghl" ? "GHL" : job.platform;
  const surface =
    job.action === "campaign" ? "Campaign" : job.entity === "companies" ? "Companies" : "People";
  return { vendor, surface };
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

/** Terminal-job breakdown — total selected / created-or-updated / failed, with
 * the first few failure reasons, matching the old in-dialog "Push complete"
 * step from push-to-emailbison-button.tsx. */
function CompletionSummary({ job }: { job: PushJobListRow }) {
  return (
    <div className="flex flex-col gap-1 text-xs text-ink-soft">
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span>
          Total selected: <strong className="text-ink">{job.total.toLocaleString("en-US")}</strong>
        </span>
        {/* Created vs updated, split per feedback item 2b. Older rows predate
            the columns, so default each to 0. */}
        <span>
          Created: <strong className="text-ink">{(job.created ?? 0).toLocaleString("en-US")}</strong>
        </span>
        <span>
          Updated: <strong className="text-ink">{(job.updated ?? 0).toLocaleString("en-US")}</strong>
        </span>
        <span>
          Failed: <strong className="text-ink">{job.failed.toLocaleString("en-US")}</strong>
        </span>
      </div>
      {job.error ? <p className="text-danger">{job.error}</p> : null}
      {job.failures.length > 0 ? (
        <div className="mt-0.5 flex flex-col gap-0.5 text-ink-mute">
          {job.failures.slice(0, 5).map((f, i) => (
            <span key={i}>
              Failed: {f.name} — {f.reason}
            </span>
          ))}
          {job.failures.length > 5 ? <span>…and {job.failures.length - 5} more</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function JobCard({ job }: { job: PushJobListRow }) {
  const { vendor, surface } = describePlatform(job);

  return (
    <div className="flex flex-col gap-3 rounded-xl border border-rule bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-ink">{job.client?.name ?? "Unknown client"}</span>
          <span className="inline-flex items-center rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-ink">
            {vendor}
          </span>
          <span className="inline-flex items-center rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-ink-soft">
            {surface}
          </span>
          {job.niche.length > 0 ? (
            job.niche.map((n) => (
              <span
                key={n}
                className="inline-flex items-center rounded-full border border-rule px-2 py-0.5 text-[11px] text-ink-soft"
              >
                {n}
              </span>
            ))
          ) : (
            <span className="text-[11px] text-ink-mute">—</span>
          )}
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
        <p className="text-xs text-ink-mute">Queued — starts after current</p>
      ) : job.status === "running" ? (
        <ProgressBar processed={job.processed} total={job.total} />
      ) : (
        <>
          <CompletionSummary job={job} />
          {/* Deep links to the People/Companies tables filtered to exactly this
              run's records (?pushJobId=<id>). Renders null for non-terminal
              jobs, but we're already in the terminal branch here. */}
          <PushJobDeepLinkButtons jobId={job.id} status={job.status} />
        </>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-ink-mute">
        <span>{job.triggeredByEmail ?? "—"}</span>
        <span aria-hidden>·</span>
        <span title={formatAbsoluteDateTime(job.createdAt)}>{timeAgo(job.createdAt)}</span>
      </div>
    </div>
  );
}

export function PushActivityView({
  rows: initialRows,
  initialHasMore,
  clients,
}: {
  rows: PushJobListRow[];
  initialHasMore: boolean;
  clients: { id: string; name: string | null }[];
}) {
  const [rows, setRows] = useState(initialRows);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [platform, setPlatform] = useState("");
  const isFiltered = Boolean(clientId || platform);
  const requestIdRef = useRef(0);

  async function fetchJobs(offset: number, filters: { clientId: string; platform: string }) {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ offset: String(offset) });
      if (filters.clientId) params.set("clientId", filters.clientId);
      if (filters.platform) params.set("platform", filters.platform);

      const res = await fetch(`/api/push-jobs?${params.toString()}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load push jobs.");
      if (requestId !== requestIdRef.current) return;

      setRows((prev) => (offset === 0 ? body.rows : [...prev, ...body.rows]));
      setHasMore(Boolean(body.hasMore));
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load push jobs.");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  const hasActive = rows.some((r) => r.status === "queued" || r.status === "running");

  // Live poll while any visible job is queued/running, stopping once all are
  // terminal — mirrors push-history-view's request-id-guarded fetch. Refetches
  // page 0 and merges by id so live counters advance and freshly-enqueued jobs
  // appear at the top without discarding already "load more"-d pages. Filters
  // and hasActive are effect deps so the interval reflects the current view and
  // tears down the moment nothing is running.
  const clientIdRef = useRef(clientId);
  const platformRef = useRef(platform);
  clientIdRef.current = clientId;
  platformRef.current = platform;

  useEffect(() => {
    if (!hasActive) return;

    async function poll() {
      // Read (don't bump) the request id: a user-initiated fetch or filter
      // change increments it and thereby invalidates an in-flight poll, but a
      // poll must never bump it — otherwise a tick firing mid-"Load more" would
      // discard that append and strand its loading spinner.
      const requestId = requestIdRef.current;
      try {
        const params = new URLSearchParams({ offset: "0" });
        if (clientIdRef.current) params.set("clientId", clientIdRef.current);
        if (platformRef.current) params.set("platform", platformRef.current);

        const res = await fetch(`/api/push-jobs?${params.toString()}`, { cache: "no-store" });
        if (!res.ok) return;
        const body = (await res.json()) as { rows: PushJobListRow[] };
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

  function loadMore() {
    fetchJobs(rows.length, { clientId, platform });
  }

  function handleFilterChange(next: { clientId: string; platform: string }) {
    setClientId(next.clientId);
    setPlatform(next.platform);
    fetchJobs(0, next);
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-3">
        <select
          value={clientId}
          onChange={(e) => handleFilterChange({ clientId: e.target.value, platform })}
          className="rounded-md border border-rule bg-card px-2 py-1.5 text-sm text-ink outline-none focus:border-stamp"
        >
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name ?? "Unnamed"}
            </option>
          ))}
        </select>
        <select
          value={platform}
          onChange={(e) => handleFilterChange({ clientId, platform: e.target.value })}
          className="rounded-md border border-rule bg-card px-2 py-1.5 text-sm text-ink outline-none focus:border-stamp"
        >
          <option value="">All platforms</option>
          {PLATFORM_OPTIONS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </select>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-rule bg-card p-8 text-center text-sm text-ink-soft">
          {isFiltered ? "No pushes match these filters." : "No pushes yet."}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {rows.map((job) => (
            <JobCard key={job.id} job={job} />
          ))}
        </div>
      )}

      {error && <p className="text-center text-xs text-red-500">{error}</p>}

      {hasMore && (
        <button
          type="button"
          onClick={loadMore}
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
