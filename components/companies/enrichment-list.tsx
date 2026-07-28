"use client";

import { useRouter } from "next/navigation";
import { Plus } from "lucide-react";
import { addableVirtualColumnType, serializeVirtualColumnsParam } from "@/lib/data/virtual-columns";
import type { EnrichmentFieldType } from "@/lib/data/enrichment-fields";

export function formatValue(value: unknown): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "object" && value !== null) return JSON.stringify(value);
  return String(value);
}

export function EnrichmentList({
  data,
  fieldTypes = {},
}: {
  data: Record<string, unknown>;
  /** Discovered type per enrichment key (lib/data/enrichment-fields.ts),
   * scoped to this key set so "Add as column" (ticket #39) assigns the same
   * VirtualColumnType — and therefore the same operators — the table's own
   * picker would. A key absent here (outside the discovery sample, or
   * blocklisted upstream via filterCustomData) gets no action. */
  fieldTypes?: Record<string, EnrichmentFieldType>;
}) {
  const router = useRouter();
  const entries = Object.entries(data);

  if (entries.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-rule px-5 py-6 text-center text-sm italic text-ink-soft">
        No enrichment data
      </div>
    );
  }

  function addAsColumn(key: string) {
    const type = addableVirtualColumnType(fieldTypes[key]);
    if (!type) return;
    const serialized = serializeVirtualColumnsParam([{ key, type }]);
    router.push(serialized ? `/companies?vc=${encodeURIComponent(serialized)}` : "/companies");
  }

  return (
    <ol className="divide-y divide-rule rounded-lg border border-rule">
      {entries.map(([key, value]) => {
        const columnType = addableVirtualColumnType(fieldTypes[key]);
        return (
          <li key={key} className="flex items-baseline gap-3 px-5 py-2.5">
            <span className="w-1/3 shrink-0 truncate text-xs font-medium text-ink-soft">{key}</span>
            <span className="flex-1 text-sm text-ink">{formatValue(value)}</span>
            {columnType && (
              <button
                type="button"
                onClick={() => addAsColumn(key)}
                className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs text-ink-soft hover:bg-hover hover:text-ink"
              >
                <Plus size={12} />
                Add as column
              </button>
            )}
          </li>
        );
      })}
    </ol>
  );
}
