"use client";

import { useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { EmailBisonSenderEmail, EmailBisonWarmupStat } from "@/lib/emailbison/client";

/** Warmup-score band thresholds (0-100), mirroring EmailBison's own warmup
 * filter groupings. Named here so they're easy to retune without hunting
 * through JSX. */
const WARMUP_HEALTHY_MIN = 80;
const WARMUP_WARMING_MIN = 30;
// Below WARMUP_WARMING_MIN (and score present) = "burnt".

type ConnectionFilter = "all" | "connected";
type WarmupFilter = "all" | "on" | "off";
type ScoreBandFilter = "all" | "healthy" | "warming" | "burnt" | "unknown";

/** A sender email merged with its (possibly not-yet-loaded) warmup stat —
 * the picker's internal working shape once the two fetches are joined by
 * id. `warmupScore`/`warmupStatsLoaded` let the UI distinguish "no score
 * data yet" from "fetched, and this mailbox has no score". */
interface MergedSenderEmail extends EmailBisonSenderEmail {
  warmupScore: number | null;
}

function scoreBand(score: number | null): Exclude<ScoreBandFilter, "all"> {
  if (score === null) return "unknown";
  if (score >= WARMUP_HEALTHY_MIN) return "healthy";
  if (score >= WARMUP_WARMING_MIN) return "warming";
  return "burnt";
}

function scoreBadgeClasses(score: number | null): string {
  switch (scoreBand(score)) {
    case "healthy":
      return "bg-green-500/10 text-green-600";
    case "warming":
      return "bg-amber-500/10 text-amber-600";
    case "burnt":
      return "bg-danger/10 text-danger";
    case "unknown":
    default:
      return "bg-hover text-ink-mute";
  }
}

function isConnected(status: string | null): boolean {
  return status?.toLowerCase() === "connected";
}

/** Filterable sender-email picker for the EmailBison create-campaign flow
 * (issue: burnt/unwarmed/disconnected mailboxes were indistinguishable in
 * the old flat checkbox list) — shared by the People and Companies "Add to
 * EmailBison Campaign" buttons so the filter logic can't diverge between the
 * two.
 *
 * Loading is staged in two fetches: the base sender-email list
 * (`/api/clients/{id}/emailbison-sender-emails`) renders the picker
 * immediately with name/email/connection-status/warmup-on badges, then the
 * warmup-stats list (`/api/clients/{id}/emailbison-warmup-scores`) is
 * fetched lazily and merged in by id to fill in numeric warmup-score badges
 * and enable the score-band filter. A failed warmup fetch degrades
 * gracefully — the picker stays fully usable, just without scores. */
export function SenderEmailPicker({
  clientId,
  selectedIds,
  onChange,
}: {
  clientId: string;
  selectedIds: string[];
  /** Replaces the full selection — callers that only need toggle semantics
   * can derive it: `onChange(current.includes(id) ? current.filter(...) : [...current, id])`. */
  onChange: (nextSelectedIds: string[]) => void;
}) {
  const [senderEmails, setSenderEmails] = useState<EmailBisonSenderEmail[] | null>(null);
  const [senderEmailsError, setSenderEmailsError] = useState<string | null>(null);

  const [warmupStats, setWarmupStats] = useState<EmailBisonWarmupStat[] | null>(null);
  const [warmupLoading, setWarmupLoading] = useState(false);
  const [warmupFailed, setWarmupFailed] = useState(false);

  const [search, setSearch] = useState("");
  const [connectionFilter, setConnectionFilter] = useState<ConnectionFilter>("all");
  const [warmupFilter, setWarmupFilter] = useState<WarmupFilter>("all");
  const [scoreBandFilter, setScoreBandFilter] = useState<ScoreBandFilter>("all");
  const [tagFilter, setTagFilter] = useState<string>("all");

  // Base list loads first, then the warmup fetch kicks off once it succeeds
  // — the picker is usable the moment the base list resolves, scores stream
  // in afterward.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setSenderEmails(null);
      setSenderEmailsError(null);
      setWarmupStats(null);
      setWarmupFailed(false);
      setSearch("");
      setConnectionFilter("all");
      setWarmupFilter("all");
      setScoreBandFilter("all");
      setTagFilter("all");

      try {
        const res = await fetch(`/api/clients/${clientId}/emailbison-sender-emails`);
        if (!res.ok) throw new Error("Failed to load sender emails");
        const data = (await res.json()) as { senderEmails: EmailBisonSenderEmail[] };
        if (cancelled) return;
        setSenderEmails(data.senderEmails);
      } catch (error) {
        if (cancelled) return;
        setSenderEmailsError((error as Error).message || "Failed to load sender emails.");
        return;
      }

      setWarmupLoading(true);
      try {
        const res = await fetch(`/api/clients/${clientId}/emailbison-warmup-scores`);
        if (!res.ok) throw new Error("Failed to load warmup scores");
        const data = (await res.json()) as { warmupStats: EmailBisonWarmupStat[] };
        if (cancelled) return;
        setWarmupStats(data.warmupStats);
      } catch {
        if (cancelled) return;
        setWarmupFailed(true);
      } finally {
        if (!cancelled) setWarmupLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const warmupScoreById = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const stat of warmupStats ?? []) {
      map.set(stat.id, stat.warmupScore);
    }
    return map;
  }, [warmupStats]);

  const merged: MergedSenderEmail[] = useMemo(
    () => (senderEmails ?? []).map((sender) => ({ ...sender, warmupScore: warmupScoreById.get(sender.id) ?? null })),
    [senderEmails, warmupScoreById]
  );

  const allTags = useMemo(() => {
    const names = new Set<string>();
    for (const sender of merged) {
      for (const tag of sender.tags) names.add(tag.name);
    }
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [merged]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return merged.filter((sender) => {
      if (q && !sender.name.toLowerCase().includes(q) && !sender.email.toLowerCase().includes(q)) return false;
      if (connectionFilter === "connected" && !isConnected(sender.status)) return false;
      if (warmupFilter === "on" && sender.warmupEnabled !== true) return false;
      if (warmupFilter === "off" && sender.warmupEnabled !== false) return false;
      if (scoreBandFilter !== "all" && scoreBand(sender.warmupScore) !== scoreBandFilter) return false;
      if (tagFilter !== "all" && !sender.tags.some((tag) => tag.name === tagFilter)) return false;
      return true;
    });
  }, [merged, search, connectionFilter, warmupFilter, scoreBandFilter, tagFilter]);

  function toggle(id: string) {
    onChange(selectedIds.includes(id) ? selectedIds.filter((existing) => existing !== id) : [...selectedIds, id]);
  }

  function selectAllFiltered() {
    const filteredIds = filtered.map((sender) => sender.id);
    const merged = new Set([...selectedIds, ...filteredIds]);
    onChange(Array.from(merged));
  }

  function clearSelection() {
    onChange([]);
  }

  return (
    <div className="flex flex-col gap-2">
      {senderEmailsError ? (
        <p className="text-xs text-danger">{senderEmailsError}</p>
      ) : senderEmails === null ? (
        <p className="flex items-center gap-2 text-xs text-ink-soft">
          <Loader2 size={12} className="animate-spin" />
          Loading sender emails…
        </p>
      ) : senderEmails.length === 0 ? (
        <p className="text-xs text-ink-mute">No sender emails connected in this workspace.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search name or email…"
              className="min-w-0 flex-1 rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
            />
            <select
              value={connectionFilter}
              onChange={(e) => setConnectionFilter(e.target.value as ConnectionFilter)}
              className="rounded-md border border-rule bg-transparent px-1.5 py-1 text-xs text-ink"
              aria-label="Connection status filter"
            >
              <option value="all">All statuses</option>
              <option value="connected">Connected only</option>
            </select>
            <select
              value={warmupFilter}
              onChange={(e) => setWarmupFilter(e.target.value as WarmupFilter)}
              className="rounded-md border border-rule bg-transparent px-1.5 py-1 text-xs text-ink"
              aria-label="Warmup on/off filter"
            >
              <option value="all">Warmup: all</option>
              <option value="on">Warmup on</option>
              <option value="off">Warmup off</option>
            </select>
            <select
              value={scoreBandFilter}
              onChange={(e) => setScoreBandFilter(e.target.value as ScoreBandFilter)}
              disabled={warmupStats === null}
              className={cn(
                "rounded-md border border-rule bg-transparent px-1.5 py-1 text-xs text-ink",
                warmupStats === null && "cursor-not-allowed opacity-50"
              )}
              aria-label="Warmup score filter"
            >
              <option value="all">Score: all</option>
              <option value="healthy">Healthy (≥{WARMUP_HEALTHY_MIN})</option>
              <option value="warming">
                Warming ({WARMUP_WARMING_MIN}–{WARMUP_HEALTHY_MIN - 1})
              </option>
              <option value="burnt">Burnt (&lt;{WARMUP_WARMING_MIN})</option>
              <option value="unknown">Unknown</option>
            </select>
            {allTags.length > 0 ? (
              <select
                value={tagFilter}
                onChange={(e) => setTagFilter(e.target.value)}
                className="rounded-md border border-rule bg-transparent px-1.5 py-1 text-xs text-ink"
                aria-label="Tag filter"
              >
                <option value="all">All tags</option>
                {allTags.map((tag) => (
                  <option key={tag} value={tag}>
                    {tag}
                  </option>
                ))}
              </select>
            ) : null}
          </div>

          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-ink-mute">
              {warmupLoading ? "Loading scores…" : warmupFailed ? "Warmup scores unavailable — showing status only." : null}
            </p>
            <div className="flex items-center gap-2">
              <button type="button" onClick={selectAllFiltered} className="text-xs text-stamp hover:underline">
                Select all (filtered)
              </button>
              <button type="button" onClick={clearSelection} className="text-xs text-ink-mute hover:text-ink">
                Clear
              </button>
            </div>
          </div>

          <div className="flex max-h-48 flex-col gap-1 overflow-y-auto rounded-md border border-rule p-2">
            {filtered.length === 0 ? (
              <p className="text-xs text-ink-mute">No sender emails match these filters.</p>
            ) : (
              filtered.map((sender) => (
                <label
                  key={sender.id}
                  className="flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs hover:bg-hover"
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.includes(sender.id)}
                    onChange={() => toggle(sender.id)}
                  />
                  <span className="text-ink">{sender.name}</span>
                  <span className="text-ink-mute">{sender.email}</span>
                  <span className="ml-auto flex shrink-0 items-center gap-1">
                    {sender.status ? (
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-medium",
                          isConnected(sender.status) ? "bg-green-500/10 text-green-600" : "bg-danger/10 text-danger"
                        )}
                      >
                        {sender.status}
                      </span>
                    ) : null}
                    {sender.warmupEnabled !== null ? (
                      <span className="rounded bg-hover px-1.5 py-0.5 text-[10px] font-medium text-ink-mute">
                        Warmup {sender.warmupEnabled ? "on" : "off"}
                      </span>
                    ) : null}
                    <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium", scoreBadgeClasses(sender.warmupScore))}>
                      {sender.warmupScore !== null ? sender.warmupScore : warmupLoading ? "…" : "—"}
                    </span>
                    {sender.tags.map((tag) => (
                      <span key={tag.id} className="rounded bg-hover px-1.5 py-0.5 text-[10px] text-ink-mute">
                        {tag.name}
                      </span>
                    ))}
                  </span>
                </label>
              ))
            )}
          </div>
        </>
      )}
    </div>
  );
}
