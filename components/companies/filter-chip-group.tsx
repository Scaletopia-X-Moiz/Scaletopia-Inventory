"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

export interface ChipOption {
  id: string;
  label: string;
  count?: number;
}

export function FilterChipGroup({
  title,
  options,
  selected,
  excluded,
  onToggle,
  onToggleExclude,
  loading = false,
  searchable = false,
}: {
  title: string;
  options: ChipOption[];
  selected: string[];
  excluded?: string[];
  onToggle: (id: string) => void;
  onToggleExclude?: (id: string) => void;
  /** True while the facet options are still being fetched, so an empty list
   * reads as "loading" rather than "no data". */
  loading?: boolean;
  /** Adds a small search box (for long, free-form lists such as open tags). */
  searchable?: boolean;
}) {
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? options.filter(
        (o) => o.label.toLowerCase().includes(needle) || selected.includes(o.id) || Boolean(excluded?.includes(o.id))
      )
    : options;
  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-ink-soft">{title}</p>
      {searchable && options.length > 8 && (
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${title.toLowerCase()}`}
          className="rounded-md border border-rule bg-card px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-soft/70 focus:border-stamp"
        />
      )}
      {options.length === 0 && loading ? (
        <p className="text-xs text-ink-soft/70">Loading…</p>
      ) : options.length === 0 ? (
        <p className="text-xs text-ink-soft/70">No {title.toLowerCase()} data for the current filters.</p>
      ) : (
        <div className="flex flex-wrap gap-1.5">
          {visible.map((option) => {
            const included = selected.includes(option.id);
            const isExcluded = Boolean(excluded?.includes(option.id));
            return (
              <div
                key={option.id}
                className={cn(
                  "group relative flex items-center rounded-full border text-xs transition-colors",
                  isExcluded
                    ? "border-red-500/60 bg-red-500/10 text-red-600"
                    : included
                      ? "border-stamp bg-stamp text-paper"
                      : "border-rule bg-card text-ink hover:border-ink-soft"
                )}
              >
                <button
                  type="button"
                  aria-pressed={included}
                  title={option.label}
                  onClick={() => onToggle(option.id)}
                  onKeyDown={(e) => {
                    if (e.key === " " || e.key === "Enter") {
                      e.preventDefault();
                      onToggle(option.id);
                    }
                  }}
                  className={cn(
                    "max-w-[260px] truncate rounded-full px-2.5 py-1 focus-visible:ring-2 focus-visible:ring-stamp/50 focus-visible:ring-offset-2",
                    isExcluded && "line-through",
                    !included && !isExcluded && "focus-visible:ring-offset-0"
                  )}
                >
                  {option.label}
                  {option.count !== undefined && (
                    <span
                      className={cn(
                        "ml-1.5 font-mono tabular-nums",
                        included ? "text-paper/70" : isExcluded ? "text-red-600/70" : "text-ink-soft"
                      )}
                    >
                      {option.count.toLocaleString("en-US")}
                    </span>
                  )}
                </button>
                {onToggleExclude && (
                  <button
                    type="button"
                    aria-label={`Exclude ${option.label}`}
                    aria-pressed={isExcluded}
                    onClick={(e) => {
                      e.stopPropagation();
                      onToggleExclude(option.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === " " || e.key === "Enter") {
                        e.preventDefault();
                        e.stopPropagation();
                        onToggleExclude(option.id);
                      }
                    }}
                    className={cn(
                      "flex items-center rounded-full pl-0.5 pr-2 py-1 focus-visible:ring-2 focus-visible:ring-red-500/50",
                      isExcluded ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    )}
                  >
                    <span aria-hidden="true">−</span>
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
