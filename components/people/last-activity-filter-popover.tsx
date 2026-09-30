"use client";

import { useEffect, useRef, useState } from "react";
import { FilterPopover } from "@/components/shared/filter-popover";
import {
  buildLastActivityFilter,
  LAST_ACTIVITY_OP_LABELS,
  type LastActivityFilter,
  type LastActivityOp,
} from "@/lib/data/last-activity-filter";
import { cn } from "@/lib/utils";

const OPS: LastActivityOp[] = ["not_empty", "empty", "within_days", "between"];

/** The GHL "Last activity" filter UI.
 *
 * Structurally a copy of components/shared/push-status-filter-popover.tsx —
 * controlled, presentational, emits a complete filter or undefined, and holds
 * partial selections in local draft state behind the same echo-guard (so our
 * own onChange doesn't wipe the half-filled form, while a URL load or a
 * clear-all does re-seed it).
 *
 * It lives under components/people/ rather than components/shared/ because,
 * unlike push status, this filter has no Companies counterpart: last activity
 * belongs to a GHL contact and only people are pushed as contacts. Putting it
 * in shared/ would advertise a symmetry that doesn't exist.
 *
 * No live preview counts. The push-status popover can afford them because its
 * counts come from a single RPC over the already-scoped view; this filter's
 * set is resolved app-side from platform_pushes, so a preview would mean a
 * second full resolution per keystroke for a number the result header already
 * shows a moment later. */
export function LastActivityFilterPopover({
  clientOptions,
  value,
  onChange,
}: {
  clientOptions: { id: string; name: string }[];
  value: LastActivityFilter | undefined;
  onChange: (next: LastActivityFilter | undefined) => void;
}) {
  const [clientId, setClientId] = useState(value?.clientId ?? "");
  const [op, setOp] = useState<LastActivityOp | "">(value?.op ?? "");
  const [from, setFrom] = useState(value?.op === "between" ? (value.from?.slice(0, 10) ?? "") : "");
  const [to, setTo] = useState(value?.op === "between" ? (value.to?.slice(0, 10) ?? "") : "");
  const [days, setDays] = useState(value?.op === "within_days" ? String(value.days) : "30");

  const echoRef = useRef<string>(JSON.stringify(value ?? null));
  useEffect(() => {
    const serialized = JSON.stringify(value ?? null);
    if (serialized === echoRef.current) return;
    echoRef.current = serialized;
    setClientId(value?.clientId ?? "");
    setOp(value?.op ?? "");
    setFrom(value?.op === "between" ? (value.from?.slice(0, 10) ?? "") : "");
    setTo(value?.op === "between" ? (value.to?.slice(0, 10) ?? "") : "");
    setDays(value?.op === "within_days" ? String(value.days) : "30");
  }, [value]);

  /** Emits whatever the draft currently adds up to — a complete filter, or
   * undefined while it's still incomplete (which clears an active filter, the
   * same all-or-nothing rule the URL parser applies). */
  function emit(next: {
    clientId?: string;
    op?: LastActivityOp | "";
    from?: string;
    to?: string;
    days?: string;
  }) {
    const nextClientId = next.clientId ?? clientId;
    const nextOp = next.op ?? op;
    const built = buildLastActivityFilter(nextClientId || undefined, nextOp || undefined, {
      from: next.from ?? from,
      to: next.to ?? to,
      days: Number(next.days ?? days),
    });
    echoRef.current = JSON.stringify(built ?? null);
    onChange(built);
  }

  return (
    <FilterPopover label="Last activity" count={value ? 1 : 0}>
      <div className="flex w-64 flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-ink-soft">GHL sub-account</p>
          <select
            value={clientId}
            onChange={(e) => {
              setClientId(e.target.value);
              emit({ clientId: e.target.value });
            }}
            className="rounded-md border border-rule bg-card px-2 py-1.5 text-xs text-ink"
          >
            <option value="">Choose a client…</option>
            {clientOptions.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
          <p className="text-[11px] text-ink-mute">
            Last activity is per sub-account, and only people pushed to it are matched.
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-semibold text-ink-soft">Condition</p>
          <div className="flex flex-wrap gap-1.5">
            {OPS.map((candidate) => (
              <button
                key={candidate}
                type="button"
                onClick={() => {
                  setOp(candidate);
                  emit({ op: candidate });
                }}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs transition-smooth",
                  op === candidate
                    ? "border-stamp bg-stamp/10 text-stamp"
                    : "border-rule text-ink-soft hover:bg-hover"
                )}
              >
                {LAST_ACTIVITY_OP_LABELS[candidate]}
              </button>
            ))}
          </div>
        </div>

        {op === "within_days" && (
          <label className="flex flex-col gap-1.5">
            <span className="text-xs font-semibold text-ink-soft">Days</span>
            <input
              type="number"
              min={1}
              value={days}
              onChange={(e) => {
                setDays(e.target.value);
                emit({ days: e.target.value });
              }}
              className="rounded-md border border-rule bg-card px-2 py-1.5 text-xs text-ink tabular-nums"
            />
          </label>
        )}

        {op === "between" && (
          <div className="flex flex-col gap-2">
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-ink-soft">From</span>
              <input
                type="date"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  emit({ from: e.target.value });
                }}
                className="rounded-md border border-rule bg-card px-2 py-1.5 text-xs text-ink"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-ink-soft">To</span>
              <input
                type="date"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  emit({ to: e.target.value });
                }}
                className="rounded-md border border-rule bg-card px-2 py-1.5 text-xs text-ink"
              />
            </label>
            <p className="text-[11px] text-ink-mute">
              Both ends are inclusive whole days. One end alone is allowed.
            </p>
          </div>
        )}

        {value && (
          <button
            type="button"
            onClick={() => {
              setOp("");
              setClientId("");
              echoRef.current = JSON.stringify(null);
              onChange(undefined);
            }}
            className="self-start text-xs text-stamp underline-offset-2 hover:underline"
          >
            Clear last-activity filter
          </button>
        )}
      </div>
    </FilterPopover>
  );
}
