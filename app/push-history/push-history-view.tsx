"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { formatAbsoluteDateTime, timeAgo } from "@/lib/utils";
import type { PushHistoryRow } from "@/lib/data/push-history";

const PLATFORM_LABELS: Record<string, string> = {
  ghl: "GHL",
  emailbison: "EmailBison",
};

const PLATFORM_OPTIONS = Object.entries(PLATFORM_LABELS).map(([value, label]) => ({
  value,
  label,
}));

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

export function PushHistoryView({
  rows: initialRows,
  initialHasMore,
  clients,
}: {
  rows: PushHistoryRow[];
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

  async function fetchPushes(offset: number, filters: { clientId: string; platform: string }) {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ offset: String(offset) });
      if (filters.clientId) params.set("clientId", filters.clientId);
      if (filters.platform) params.set("platform", filters.platform);

      const res = await fetch(`/api/push-history?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load pushes.");
      if (requestId !== requestIdRef.current) return;

      setRows((prev) => (offset === 0 ? body.rows : [...prev, ...body.rows]));
      setHasMore(Boolean(body.hasMore));
    } catch (err) {
      if (requestId !== requestIdRef.current) return;
      setError(err instanceof Error ? err.message : "Failed to load pushes.");
    } finally {
      if (requestId === requestIdRef.current) setLoading(false);
    }
  }

  function loadMore() {
    fetchPushes(rows.length, { clientId, platform });
  }

  function handleFilterChange(next: { clientId: string; platform: string }) {
    setClientId(next.clientId);
    setPlatform(next.platform);
    fetchPushes(0, next);
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

      {/* Push History is a per-person ledger (one row per platform_pushes
          record). A Companies push targets the People linked to the matched
          companies (ADR 0003), so companies with no linked people create no
          rows here at all — the Push Activity panel is where a company push's
          "X companies → Y people" summary lives, including the 0-people case
          that never surfaces in this table. */}
      <p className="text-xs text-ink-mute">
        Each row is one person. A Companies push shows the people it reached here; its
        company-vs-people breakdown (including company selections that had no linked people, which
        add no rows) lives in{" "}
        <Link href="/push-activity" className="text-stamp hover:underline">
          Push Activity
        </Link>
        .
      </p>

      {rows.length === 0 ? (
        <div className="rounded-xl border border-rule bg-card p-8 text-center text-sm text-ink-soft">
          {isFiltered ? "No pushes match these filters." : "No pushes recorded yet."}
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-rule bg-card">
          <table className="w-full min-w-[840px] text-sm">
            <thead>
              <tr className="border-b border-rule text-left text-xs text-ink-mute">
                <th className="px-4 py-3 font-medium">Person</th>
                <th className="px-4 py-3 font-medium">Client</th>
                <th className="px-4 py-3 font-medium">Platform</th>
                <th className="px-4 py-3 font-medium">Campaign</th>
                <th className="px-4 py-3 font-medium">Platform ID</th>
                <th className="px-4 py-3 font-medium">Pushed by</th>
                <th className="px-4 py-3 font-medium">When</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-rule/60 last:border-0">
                  <td className="px-4 py-3 text-ink">
                    {r.person ? (
                      <Link href={`/people/${r.person.id}`} className="text-stamp hover:underline">
                        {r.person.name ?? "Unnamed"}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{r.client?.name ?? "—"}</td>
                  <td className="px-4 py-3">
                    <span className="inline-flex items-center rounded-full bg-hover px-2 py-0.5 text-[11px] font-medium text-ink">
                      {platformLabel(r.platform)}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{r.campaignTag ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-ink-soft">
                    {r.platformContactId ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-ink-soft">{r.pushedByEmail ?? "—"}</td>
                  <td
                    className="whitespace-nowrap px-4 py-3 text-ink-soft"
                    title={formatAbsoluteDateTime(r.pushedAt)}
                  >
                    {timeAgo(r.pushedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
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
