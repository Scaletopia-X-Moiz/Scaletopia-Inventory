"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { X } from "lucide-react";
import { formatAbsoluteDateTime, timeAgo } from "@/lib/utils";
// Type-only import (erased at compile time), so this client component never
// pulls in the `server-only` push-jobs module at runtime — it just single-
// sources the summary wire contract the /summary endpoint returns.
import type { PushJobSummary } from "@/lib/data/push-jobs";

// Cache summaries per job id so re-renders / navigations don't refetch a label
// that never changes for a terminal job.
const cache = new Map<string, PushJobSummary>();

/** The `?pushJobId=` deep-link (#123) rendered as a first-class, removable
 * filter chip — the same status as any facet chip, but sourced from the URL
 * rather than a facet popover. Labels the run by client + when it ran (falling
 * back to a short id until the summary loads or if it 404s) so the filter reads
 * as "From push <client> · <ago>" instead of a raw uuid. Removing it strips
 * both `pushJobId` and its `pushJobOutcome` sub-scope from the URL. Renders
 * nothing when no pushJobId is active, so it's safe to mount unconditionally in
 * either filter slip. */
export function PushJobFilterChip() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const pushJobId = searchParams.get("pushJobId");
  const outcome = searchParams.get("pushJobOutcome");

  // Holds only the async fetch result; the displayed summary is derived below
  // (cache first) so no state is reset synchronously when pushJobId changes.
  const [fetched, setFetched] = useState<PushJobSummary | null>(null);

  useEffect(() => {
    if (!pushJobId || cache.has(pushJobId)) return;
    const controller = new AbortController();
    fetch(`/api/push-jobs/${pushJobId}/summary`, { signal: controller.signal })
      .then((r) => (r.ok ? (r.json() as Promise<PushJobSummary>) : null))
      .then((data) => {
        if (data) {
          cache.set(pushJobId, data);
          setFetched(data);
        }
      })
      .catch(() => {
        // Keep the fallback label; a missing/failed summary doesn't disable the
        // filter itself (results are already filtered server-side by the id).
      });
    return () => controller.abort();
  }, [pushJobId]);

  if (!pushJobId) return null;

  // Prefer the cache; fall back to the just-fetched value only when it's for
  // the current job, so switching jobs never flashes a stale label.
  const summary =
    cache.get(pushJobId) ?? (fetched?.id === pushJobId ? fetched : null);

  const client = summary?.clientName?.trim() || "Unknown client";
  const outcomeSuffix = outcome === "succeeded" ? " · succeeded" : outcome === "failed" ? " · failed" : "";
  const label = summary
    ? `From push · ${client} · ${timeAgo(summary.createdAt)}${outcomeSuffix}`
    : `From push · ${pushJobId.slice(0, 8)}${outcomeSuffix}`;

  function remove() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("pushJobId");
    params.delete("pushJobOutcome");
    params.delete("page");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <span
      className="inline-flex items-center gap-1.5 rounded-full border border-stamp/40 bg-stamp/10 px-2.5 py-1 text-xs font-medium text-stamp"
      title={summary ? formatAbsoluteDateTime(summary.createdAt) : undefined}
    >
      {label}
      <button
        type="button"
        onClick={remove}
        aria-label="Remove push filter"
        className="rounded-full p-0.5 transition-smooth hover:bg-stamp/20 focus-visible:ring-2 focus-visible:ring-stamp/50"
      >
        <X size={12} />
      </button>
    </span>
  );
}
