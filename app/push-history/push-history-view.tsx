"use client";

import { useState } from "react";
import Link from "next/link";
import { Loader2 } from "lucide-react";
import { timeAgo } from "@/lib/utils";
import type { PushHistoryRow } from "@/lib/data/push-history";

const PLATFORM_LABELS: Record<string, string> = {
  ghl: "GHL",
  emailbison: "EmailBison",
};

function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

function fmtAbsolute(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function PushHistoryView({
  rows: initialRows,
  initialHasMore,
}: {
  rows: PushHistoryRow[];
  initialHasMore: boolean;
}) {
  const [rows, setRows] = useState(initialRows);
  const [hasMore, setHasMore] = useState(initialHasMore);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadMore() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/push-history?offset=${rows.length}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Failed to load more pushes.");
      setRows((prev) => [...prev, ...body.rows]);
      setHasMore(Boolean(body.hasMore));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load more pushes.");
    } finally {
      setLoading(false);
    }
  }

  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-rule bg-card p-8 text-center text-sm text-ink-soft">
        No pushes recorded yet.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
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
                  title={fmtAbsolute(r.pushedAt)}
                >
                  {timeAgo(r.pushedAt)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
