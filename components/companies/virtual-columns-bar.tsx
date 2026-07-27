"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  operatorsForType,
  parseVirtualColumnsParam,
  parseVirtualFiltersParam,
  serializeVirtualColumnsParam,
  serializeVirtualFiltersParam,
  type ActiveVirtualColumn,
  type VirtualColumnFilter,
  type VirtualColumnOperator,
  type VirtualColumnOperatorMeta,
  type VirtualColumnType,
} from "@/lib/data/virtual-columns";

type EnrichmentFieldType = "Text" | "Number" | "Boolean" | "List" | "Date";

interface EnrichmentField {
  key: string;
  type: EnrichmentFieldType;
  sampleValues: string[];
}

/** The enrichment-field types ticket #35 can add as columns, mapped to the
 * VirtualColumnType the filter/predicate speaks. Boolean/List are discovered
 * but not yet addable (ticket #36). */
const ADDABLE_TYPES: Record<string, VirtualColumnType> = {
  Text: "text",
  Number: "number",
  Date: "date",
};

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

  function addColumn(key: string, type: VirtualColumnType) {
    if (activeColumns.some((c) => c.key === key)) return;
    writeColumns([...activeColumns, { key, type }]);
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
  onAdd: (key: string, type: VirtualColumnType) => void;
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

  const addableFields = (fields ?? []).filter(
    (f) => f.type in ADDABLE_TYPES && !addedKeys.includes(f.key)
  );

  return (
    <FilterPopoverButton open={open} onOpenChange={setOpen}>
      <p className="mb-2 text-xs font-medium text-ink-soft">Add column from enrichment</p>
      {loading ? (
        <p className="text-xs text-ink-soft/70">Loading fields…</p>
      ) : addableFields.length === 0 ? (
        <p className="text-xs text-ink-soft/70">
          No addable enrichment fields for the current filters.
        </p>
      ) : (
        <ul className="flex max-h-64 flex-col gap-0.5 overflow-y-auto">
          {addableFields.map((field) => (
            <li key={field.key}>
              <button
                type="button"
                onClick={() => {
                  onAdd(field.key, ADDABLE_TYPES[field.type]);
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-left text-sm text-ink hover:bg-hover"
              >
                <span className="truncate">{field.key}</span>
                <span className="shrink-0 text-xs text-ink-soft/70">{field.type}</span>
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

/** The two raw input strings a chip holds: `a` for single-value operators and
 * the low end of a range, `b` for the high end of a `between` range. Kept as
 * strings (what the DOM inputs produce) and coerced to the typed
 * VirtualColumnFilter["value"] only at commit time. */
function initialInputs(filter: VirtualColumnFilter | undefined): { a: string; b: string } {
  const v = filter?.value;
  if (Array.isArray(v)) return { a: String(v[0] ?? ""), b: String(v[1] ?? "") };
  if (v == null) return { a: "", b: "" };
  return { a: String(v), b: "" };
}

const INPUT_TYPE: Record<VirtualColumnType, "text" | "number" | "date"> = {
  text: "text",
  number: "number",
  boolean: "text",
  list: "text",
  date: "date",
};

/** Coerces the raw input string(s) into the typed filter value, returning
 * `undefined` when the value is incomplete/invalid so the caller clears the
 * filter rather than sending a half-formed one. Number inputs parse to real
 * numbers (so `9 < 90` compares numerically SQL-side, not as "9" > "90");
 * date inputs stay ISO strings. */
function coerceValue(
  type: VirtualColumnType,
  meta: VirtualColumnOperatorMeta,
  a: string,
  b: string
): VirtualColumnFilter["value"] | undefined {
  if (meta.requiresRange) {
    if (type === "number") {
      if (a.trim() === "" || b.trim() === "") return undefined;
      const lo = Number(a);
      const hi = Number(b);
      return Number.isFinite(lo) && Number.isFinite(hi) ? [lo, hi] : undefined;
    }
    return a && b ? [a, b] : undefined;
  }
  if (meta.requiresValue) {
    if (type === "number") {
      if (a.trim() === "") return undefined;
      const n = Number(a);
      return Number.isFinite(n) ? n : undefined;
    }
    return a ? a : undefined;
  }
  return undefined;
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
  const [inputs, setInputs] = useState(() => initialInputs(filter));

  useEffect(() => {
    setInputs(initialInputs(filter));
  }, [filter?.value]);

  const operators = operatorsForType(column.type);
  const operator = filter?.operator ?? "";
  const operatorMeta = operators.find((o) => o.id === operator);
  const inputType = INPUT_TYPE[column.type];

  function commit(nextOperator: string, next: { a: string; b: string }) {
    if (!nextOperator) {
      onChangeFilter(null);
      return;
    }
    const meta = operators.find((o) => o.id === nextOperator);
    if (!meta) {
      onChangeFilter(null);
      return;
    }
    const value = coerceValue(column.type, meta, next.a, next.b);
    if ((meta.requiresValue || meta.requiresRange) && value === undefined) {
      onChangeFilter(null);
      return;
    }
    onChangeFilter({
      key: column.key,
      type: column.type,
      operator: nextOperator as VirtualColumnOperator,
      value,
    });
  }

  function onOperatorChange(next: string) {
    commit(next, inputs);
  }

  function onInputChange(part: "a" | "b", raw: string) {
    const next = { ...inputs, [part]: raw };
    setInputs(next);
    commit(operator, next);
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
        onChange={(e) => onOperatorChange(e.target.value)}
        className="rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none focus:border-stamp"
      >
        <option value="">no filter</option>
        {operators.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {operatorMeta?.requiresValue && (
        <input
          type={inputType}
          value={inputs.a}
          onChange={(e) => onInputChange("a", e.target.value)}
          placeholder="value"
          className="w-28 rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none placeholder:text-ink-mute focus:border-stamp"
        />
      )}
      {operatorMeta?.requiresRange && (
        <>
          <input
            type={inputType}
            value={inputs.a}
            onChange={(e) => onInputChange("a", e.target.value)}
            placeholder="min"
            className="w-24 rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none placeholder:text-ink-mute focus:border-stamp"
          />
          <span className="text-ink-soft">and</span>
          <input
            type={inputType}
            value={inputs.b}
            onChange={(e) => onInputChange("b", e.target.value)}
            placeholder="max"
            className="w-24 rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none placeholder:text-ink-mute focus:border-stamp"
          />
        </>
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
