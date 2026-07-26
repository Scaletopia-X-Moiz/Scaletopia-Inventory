"use client";

import { Popover } from "radix-ui";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";

export function FilterPopover({
  label,
  count,
  children,
}: {
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  const active = count > 0;

  return (
    <Popover.Root>
      <Popover.Trigger asChild>
        <button
          type="button"
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors",
            active
              ? "border-stamp/40 bg-stamp/10 text-stamp"
              : "border-rule bg-card text-ink hover:border-ink-soft"
          )}
        >
          {label}
          {active && <span className="font-mono text-xs tabular-nums">{count}</span>}
          <ChevronDown size={14} className="opacity-60" />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          collisionPadding={12}
          className="z-30 max-h-[min(24rem,var(--radix-popover-content-available-height))] w-72 overflow-y-auto overscroll-contain rounded-lg border border-rule bg-card p-4 shadow-lg"
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
