"use client";

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
}: {
  title: string;
  options: ChipOption[];
  selected: string[];
  excluded?: string[];
  onToggle: (id: string) => void;
  onToggleExclude?: (id: string) => void;
}) {
  if (options.length === 0) return null;

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs font-medium text-ink-soft">{title}</p>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
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
                onClick={() => onToggle(option.id)}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    onToggle(option.id);
                  }
                }}
                className={cn(
                  "rounded-full px-2.5 py-1 focus-visible:ring-2 focus-visible:ring-stamp/50 focus-visible:ring-offset-2",
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
    </div>
  );
}
