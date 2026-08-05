"use client";

import { useEffect, useRef, useState } from "react";
import { FilterPopover } from "@/components/shared/filter-popover";
import {
  buildPushStatusFilter,
  pushStatusFilterLabel,
  PUSH_PLATFORM_LABELS,
  PUSH_STATUS_LABELS,
  type PushPlatform,
  type PushStatus,
  type PushStatusFilter,
} from "@/lib/data/push-status-filter";
import { cn } from "@/lib/utils";

const PLATFORMS: PushPlatform[] = ["ghl", "emailbison"];
const STATUSES: PushStatus[] = ["not_pushed", "pushed"];

/** Shared push-status filter UI for both the People and Companies filter slips,
 * so the two tables can't diverge on push-filter UX (issue #128, epic #125).
 *
 * Purely presentational and controlled: `value` in, `onChange` out. It emits a
 * complete PushStatusFilter only once client + platform + status are all set,
 * otherwise undefined. Persistence (the three URL params) lives in P2/C2.
 *
 * `value` can only represent a *complete* filter, so partial selections (e.g.
 * client picked but no status yet) are held in local draft state. An echo-guard
 * keeps our own emits from wiping that draft, while genuine external changes —
 * a URL load or a clear-all — re-sync it. */
export function PushStatusFilterPopover({
  clientOptions,
  value,
  onChange,
}: {
  clientOptions: { id: string; name: string }[];
  value: PushStatusFilter | undefined;
  onChange: (next: PushStatusFilter | undefined) => void;
}) {
  const [clientId, setClientId] = useState(value?.clientId ?? "");
  const [platform, setPlatform] = useState<PushPlatform | "">(value?.platform ?? "");
  const [status, setStatus] = useState<PushStatus | "">(value?.status ?? "");

  // Ignore the re-render caused by our own onChange; only re-seed the draft on
  // changes that originate outside this component (serialized-value compare).
  const echoRef = useRef<string>(JSON.stringify(value ?? null));
  useEffect(() => {
    const serialized = JSON.stringify(value ?? null);
    if (serialized === echoRef.current) return;
    echoRef.current = serialized;
    setClientId(value?.clientId ?? "");
    setPlatform(value?.platform ?? "");
    setStatus(value?.status ?? "");
  }, [value]);

  function emit(nextClient: string, nextPlatform: PushPlatform | "", nextStatus: PushStatus | "") {
    const filter = buildPushStatusFilter(
      nextClient || undefined,
      nextPlatform || undefined,
      nextStatus || undefined
    );
    echoRef.current = JSON.stringify(filter ?? null);
    onChange(filter);
  }

  function pickClient(id: string) {
    setClientId(id);
    emit(id, platform, status);
  }

  function pickPlatform(next: PushPlatform) {
    setPlatform(next);
    emit(clientId, next, status);
  }

  function pickStatus(next: PushStatus) {
    setStatus(next);
    emit(clientId, platform, next);
  }

  function clear() {
    setClientId("");
    setPlatform("");
    setStatus("");
    emit("", "", "");
  }

  // Fall back to the raw client id if options haven't loaded / don't include it,
  // so an active filter (badge = 1) always reads like the spec rather than
  // silently degrading the trigger to the generic "Push status".
  const active = value !== undefined;
  const label = value
    ? pushStatusFilterLabel(value, clientOptions.find((c) => c.id === value.clientId)?.name ?? value.clientId)
    : "Push status";

  return (
    <FilterPopover label={label} count={active ? 1 : 0}>
      <div className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <label htmlFor="push-status-client" className="text-xs font-medium text-ink-soft">
            Client
          </label>
          <select
            id="push-status-client"
            value={clientId}
            onChange={(e) => pickClient(e.target.value)}
            className="rounded-md border border-rule bg-card px-2.5 py-1.5 text-sm text-ink outline-none focus:border-stamp"
          >
            <option value="">Select a client…</option>
            {clientOptions.map((client) => (
              <option key={client.id} value={client.id}>
                {client.name}
              </option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-ink-soft">Platform</p>
          <div className="flex flex-wrap gap-1.5">
            {PLATFORMS.map((option) => {
              const isActive = platform === option;
              return (
                <button
                  key={option}
                  type="button"
                  aria-pressed={isActive}
                  onClick={() => pickPlatform(option)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs transition-colors",
                    isActive
                      ? "border-stamp bg-stamp text-paper"
                      : "border-rule bg-card text-ink hover:border-ink-soft"
                  )}
                >
                  {PUSH_PLATFORM_LABELS[option]}
                </button>
              );
            })}
          </div>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-xs font-medium text-ink-soft">Status</legend>
          <div className="flex flex-col gap-1.5">
            {STATUSES.map((option) => {
              const isActive = status === option;
              return (
                <label
                  key={option}
                  className="flex items-center justify-between gap-2 text-sm text-ink"
                >
                  <span className="flex items-center gap-2">
                    <input
                      type="radio"
                      name="push-status"
                      value={option}
                      checked={isActive}
                      onChange={() => pickStatus(option)}
                      className="accent-stamp"
                    />
                    {PUSH_STATUS_LABELS[option]}
                  </span>
                  {/* Room reserved for the live preview count (E1); not wired here. */}
                  <span className="font-mono text-xs tabular-nums text-ink-soft/50" aria-hidden="true" />
                </label>
              );
            })}
          </div>
        </fieldset>

        <button
          type="button"
          onClick={clear}
          disabled={!clientId && !platform && !status}
          className="self-start text-xs text-stamp underline-offset-2 hover:underline disabled:opacity-30 disabled:cursor-not-allowed disabled:no-underline"
        >
          Clear
        </button>
      </div>
    </FilterPopover>
  );
}
