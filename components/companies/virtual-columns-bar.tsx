"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  TEXT_OPERATORS,
  parseVirtualColumnsParam,
  parseVirtualFiltersParam,
  serializeVirtualColumnsParam,
  serializeVirtualFiltersParam,
  type ActiveVirtualColumn,
  type VirtualColumnFilter,
  type VirtualColumnOperator,
} from "@/lib/data/virtual-columns";

interface EnrichmentField {
  key: string;
  type: "Text" | "Number" | "Boolean" | "List" | "Date";
  sampleValues: string[];
}

/** "Add column from enrichment" + the operator controls for each active
 * virtual column (ticket #34). Reads/writes the `vc` (which fields are shown)
 * and `vf` (which of them are actively filtering) URL params directly — no
 * separate client cache, since the URL already survives a page refresh. */
export function VirtualColumnsBar() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const activeColumns = parseVirtualColumnsParam(searchParams);
  const activeFilters = parseVirtualFiltersParam(searchParams) ?? [];

  function navigate(mutate: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    params.delete("page");
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }

  function writeColumns(next: ActiveVirtualColumn[]) {
    navigate((params) => {
      const serialized = serializeVirtualColumnsParam(next);
      if (serialized) params.set("vc", serialized);
      else params.delete("vc");
    });
  }

  function writeFilters(next: VirtualColumnFilter[]) {
    navigate((params) => {
      const serialized = serializeVirtualFiltersParam(next);
      if (serialized) params.set("vf", serialized);
      else params.delete("vf");
    });
  }

  function addColumn(key: string) {
    if (activeColumns.some((c) => c.key === key)) return;
    writeColumns([...activeColumns, { key, type: "text" }]);
  }

  function removeColumn(key: string) {
    writeColumns(activeColumns.filter((c) => c.key !== key));
    writeFilters(activeFilters.filter((f) => f.key !== key));
  }

  function setFilter(key: string, filter: VirtualColumnFilter | null) {
    const rest = activeFilters.filter((f) => f.key !== key);
    writeFilters(filter ? [...rest, filter] : rest);
  }

  if (activeColumns.length === 0) {
    return <AddColumnButton onAdd={addColumn} addedKeys={[]} />;
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {activeColumns.map((col) => (
        <VirtualColumnChip
          key={col.key}
          column={col}
          filter={activeFilters.find((f) => f.key === col.key)}
          onChangeFilter={(f) => setFilter(col.key, f)}
          onRemove={() => removeColumn(col.key)}
        />
      ))}
      <AddColumnButton onAdd={addColumn} addedKeys={activeColumns.map((c) => c.key)} />
    </div>
  );
}

function AddColumnButton({
  onAdd,
  addedKeys,
}: {
  onAdd: (key: string) => void;
  addedKeys: string[];
}) {
  const searchParams = useSearchParams();
  const [fields, setFields] = useState<EnrichmentField[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open || fields !== null) return;
    setLoading(true);
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    fetch(`/api/companies/enrichment-fields?${params.toString()}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status.toString());
        return r.json() as Promise<{ fields: EnrichmentField[] }>;
      })
      .then((data) => setFields(data.fields))
      .catch(() => setFields([]))
      .finally(() => setLoading(false));
    // Field discovery is scoped to the filters active when the popover opens;
    // it doesn't need to live-refetch as those change while it's open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const textFields = (fields ?? []).filter(
    (f) => f.type === "Text" && !addedKeys.includes(f.key)
  );

  return (
    <FilterPopoverButton open={open} onOpenChange={setOpen}>
      <p className="mb-2 text-xs font-medium text-ink-soft">Add column from enrichment</p>
      {loading ? (
        <p className="text-xs text-ink-soft/70">Loading fields…</p>
      ) : textFields.length === 0 ? (
        <p className="text-xs text-ink-soft/70">
          No addable text enrichment fields for the current filters.
        </p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {textFields.map((field) => (
            <li key={field.key}>
              <button
                type="button"
                onClick={() => {
                  onAdd(field.key);
                  setOpen(false);
                }}
                className="w-full truncate rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-hover"
              >
                {field.key}
              </button>
            </li>
          ))}
        </ul>
      )}
    </FilterPopoverButton>
  );
}

/** A trigger + popover in the same visual language as FilterPopover, but with
 * a "+" icon trigger instead of a labeled filter chip, and controlled open
 * state (so selecting a field can close it). */
function FilterPopoverButton({
  open,
  onOpenChange,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className="inline-flex items-center gap-1.5 rounded-md border border-dashed border-rule bg-card px-3 py-1.5 text-sm text-ink-soft hover:border-ink-soft hover:text-ink"
      >
        <Plus size={14} />
        Add column
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => onOpenChange(false)} />
          <div className="absolute left-0 top-full z-30 mt-1.5 w-72 rounded-lg border border-rule bg-card p-3 shadow-lg">
            {children}
          </div>
        </>
      )}
    </div>
  );
}

function VirtualColumnChip({
  column,
  filter,
  onChangeFilter,
  onRemove,
}: {
  column: ActiveVirtualColumn;
  filter: VirtualColumnFilter | undefined;
  onChangeFilter: (filter: VirtualColumnFilter | null) => void;
  onRemove: () => void;
}) {
  const [value, setValue] = useState(typeof filter?.value === "string" ? filter.value : "");

  useEffect(() => {
    setValue(typeof filter?.value === "string" ? filter.value : "");
  }, [filter?.value]);

  const operator = filter?.operator ?? "";
  const operatorMeta = TEXT_OPERATORS.find((o) => o.id === operator);

  function commit(nextOperator: string, nextValue: string) {
    if (!nextOperator) {
      onChangeFilter(null);
      return;
    }
    const meta = TEXT_OPERATORS.find((o) => o.id === nextOperator);
    if (meta?.requiresValue && !nextValue.trim()) {
      onChangeFilter(null);
      return;
    }
    onChangeFilter({
      key: column.key,
      type: "text",
      operator: nextOperator as VirtualColumnOperator,
      value: meta?.requiresValue ? nextValue : undefined,
    });
  }

  return (
    <div
      className={cn(
        "flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-xs",
        filter ? "border-stamp/40 bg-stamp/10" : "border-rule bg-card"
      )}
    >
      <span className="font-medium text-ink" title={column.key}>
        {column.key}
      </span>
      <select
        value={operator}
        onChange={(e) => commit(e.target.value, value)}
        className="rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none focus:border-stamp"
      >
        <option value="">no filter</option>
        {TEXT_OPERATORS.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {operatorMeta?.requiresValue && (
        <input
          type="text"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            commit(operator, e.target.value);
          }}
          placeholder="value"
          className="w-28 rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none placeholder:text-ink-mute focus:border-stamp"
        />
      )}
      <button
        type="button"
        aria-label={`Remove ${column.key} column`}
        onClick={onRemove}
        className="text-ink-soft hover:text-ink"
      >
        <X size={13} />
      </button>
    </div>
  );
}
