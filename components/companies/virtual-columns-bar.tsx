"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ADDABLE_ENRICHMENT_TYPES,
  isLowCardinalityTextField,
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

/** One shared enrichment-field discovery for the whole bar: the "Add column"
 * picker and every column chip's value picker read the same discovered fields
 * (and their authoritative `sampleValues`) instead of each fetching their own.
 * Loads lazily on first need (`ensureLoaded`) and reloads only when the *native*
 * filter scope changes — page/vc/vf are stripped from the scope key, so adding a
 * column or toggling a value in the picker never re-fires discovery (that's what
 * keeps the picker stable and the value-add feeling instant, ticket #38). */
function useEnrichmentFields() {
  const searchParams = useSearchParams();
  // Discovery result tagged with the scope it was fetched for, so a scope
  // change invalidates it by derivation (below) rather than via a
  // setState-in-effect reset.
  const [state, setState] = useState<{
    scope: string;
    fields: EnrichmentField[] | null;
    loading: boolean;
  }>({ scope: "", fields: null, loading: false });
  const startedRef = useRef<string | null>(null);

  const scopeKey = useMemo(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("page");
    params.delete("vc");
    params.delete("vf");
    return params.toString();
  }, [searchParams]);

  const forCurrentScope = state.scope === scopeKey;
  const fields = forCurrentScope ? state.fields : null;
  const loading = forCurrentScope ? state.loading : false;

  const ensureLoaded = useCallback(() => {
    if (startedRef.current === scopeKey) return;
    startedRef.current = scopeKey;
    setState({ scope: scopeKey, fields: null, loading: true });
    fetch(`/api/companies/enrichment-fields?${scopeKey}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status.toString());
        return r.json() as Promise<{ fields: EnrichmentField[] }>;
      })
      .then((data) => setState({ scope: scopeKey, fields: data.fields, loading: false }))
      .catch(() => setState({ scope: scopeKey, fields: [], loading: false }));
  }, [scopeKey]);

  return { fields, loading, ensureLoaded };
}

/** "Add column from enrichment" + the operator controls for each active
 * virtual column (ticket #34). Reads/writes the `vc` (which fields are shown)
 * and `vf` (which of them are actively filtering) URL params directly — no
 * separate client cache, since the URL already survives a page refresh.
 *
 * `onScreenValues[key]` carries the distinct values already rendered for each
 * column on the current page, so a Text `is` value picker can show candidates
 * instantly while the discovery RPC resolves the fuller, authoritative set
 * (ticket #38). */
export function VirtualColumnsBar({
  onScreenValues = {},
}: {
  onScreenValues?: Record<string, string[]>;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { fields, loading, ensureLoaded } = useEnrichmentFields();

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

  /** The field's authoritative distinct values from discovery, or `null` while
   * discovery is still loading (fields === null). Once loaded, a key absent
   * from discovery resolves to an empty list — "no known values" — which the
   * chip reads as "fall back to free-text", never a stuck preview. */
  function authoritativeValuesFor(key: string): string[] | null {
    if (fields === null) return null;
    return fields.find((f) => f.key === key)?.sampleValues ?? [];
  }

  if (activeColumns.length === 0) {
    return (
      <AddColumnButton
        fields={fields}
        loading={loading}
        ensureLoaded={ensureLoaded}
        onAdd={addColumn}
        addedKeys={[]}
      />
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {activeColumns.map((col) => (
        <VirtualColumnChip
          key={col.key}
          column={col}
          filter={activeFilters.find((f) => f.key === col.key)}
          authoritativeValues={col.type === "text" ? authoritativeValuesFor(col.key) : null}
          onScreenValues={onScreenValues[col.key] ?? []}
          ensureFieldsLoaded={ensureLoaded}
          onChangeFilter={(f) => setFilter(col.key, f)}
          onRemove={() => removeColumn(col.key)}
        />
      ))}
      <AddColumnButton
        fields={fields}
        loading={loading}
        ensureLoaded={ensureLoaded}
        onAdd={addColumn}
        addedKeys={activeColumns.map((c) => c.key)}
      />
    </div>
  );
}

function AddColumnButton({
  fields,
  loading,
  ensureLoaded,
  onAdd,
  addedKeys,
}: {
  fields: EnrichmentField[] | null;
  loading: boolean;
  ensureLoaded: () => void;
  onAdd: (key: string, type: VirtualColumnType) => void;
  addedKeys: string[];
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) ensureLoaded();
  }, [open, ensureLoaded]);

  const addableFields = (fields ?? []).filter(
    (f) => f.type in ADDABLE_ENRICHMENT_TYPES && !addedKeys.includes(f.key)
  );

  return (
    <FilterPopoverButton open={open} onOpenChange={setOpen}>
      <p className="mb-2 text-xs font-medium text-ink-soft">Add column from enrichment</p>
      {loading && fields === null ? (
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
                  onAdd(field.key, ADDABLE_ENRICHMENT_TYPES[field.type]);
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
 * VirtualColumnFilter["value"] only at commit time. A value-list filter (Text
 * is/is_not, ticket #38) doesn't flow through here — it lives in the URL as an
 * array and is edited via the multi-select, not these text inputs. */
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
  authoritativeValues,
  onScreenValues,
  ensureFieldsLoaded,
  onChangeFilter,
  onRemove,
}: {
  column: ActiveVirtualColumn;
  filter: VirtualColumnFilter | undefined;
  /** The field's authoritative distinct values (discovery RPC), or `null` while
   * still loading. Text columns only; `null` for number/date. */
  authoritativeValues: string[] | null;
  /** Distinct values already rendered for this column on the current page — the
   * instant preview seed the picker shows before discovery resolves. */
  onScreenValues: string[];
  ensureFieldsLoaded: () => void;
  onChangeFilter: (filter: VirtualColumnFilter | null) => void;
  onRemove: () => void;
}) {
  const [inputs, setInputs] = useState(() => initialInputs(filter));
  // The operator is held locally (not derived from `filter`) so it persists
  // after it's picked but before a value exists — otherwise selecting "is"
  // with no value yet would immediately clear the filter and snap the dropdown
  // back to "no filter", leaving nowhere to enter the value (ticket #38).
  const [operator, setOperator] = useState<string>(filter?.operator ?? "");

  useEffect(() => {
    setInputs(initialInputs(filter));
  }, [filter?.value]);

  // A Text column may offer a multi-select of its real values — make sure the
  // authoritative set is being fetched so the preview can reconcile.
  useEffect(() => {
    if (column.type === "text") ensureFieldsLoaded();
  }, [column.type, ensureFieldsLoaded]);

  const operators = operatorsForType(column.type);
  const operatorMeta = operators.find((o) => o.id === operator);
  const inputType = INPUT_TYPE[column.type];

  /** Whether operator `op` on this column is edited as a multi-select of real
   * values rather than free text: a low-cardinality Text `is`/`is_not`. While
   * discovery is still loading (authoritativeValues === null) we optimistically
   * use the on-screen preview so the picker shows immediately; once the
   * authoritative set resolves it decides — and a high-cardinality field falls
   * back to free-text matching (ticket #38, acceptance criteria 1 & 2). */
  function isValueListMode(op: string): boolean {
    if (column.type !== "text" || (op !== "is" && op !== "is_not")) return false;
    if (authoritativeValues === null) return onScreenValues.length > 0;
    return isLowCardinalityTextField(authoritativeValues);
  }

  function currentSelected(): string[] {
    if (Array.isArray(filter?.value)) return filter.value as string[];
    if (typeof filter?.value === "string") return [filter.value];
    return [];
  }

  /** Writes (or clears) the filter for `op` with an already-typed value. A
   * value-less operator (is empty / is not empty) commits with no value; a
   * value-taking one with `undefined` clears the filter but leaves `operator`
   * selected locally so its value UI stays on screen. */
  function emit(op: string, value: VirtualColumnFilter["value"] | undefined) {
    const meta = operators.find((o) => o.id === op);
    if (!op || !meta) {
      onChangeFilter(null);
      return;
    }
    if (!meta.requiresValue && !meta.requiresRange) {
      onChangeFilter({ key: column.key, type: column.type, operator: op as VirtualColumnOperator });
      return;
    }
    if (value === undefined) {
      onChangeFilter(null);
      return;
    }
    onChangeFilter({ key: column.key, type: column.type, operator: op as VirtualColumnOperator, value });
  }

  function changeOperator(next: string) {
    setOperator(next);
    const meta = operators.find((o) => o.id === next);
    if (!next || !meta) {
      onChangeFilter(null);
      return;
    }
    if (isValueListMode(next)) {
      const selected = currentSelected();
      emit(next, selected.length ? selected : undefined);
    } else {
      emit(next, coerceValue(column.type, meta, inputs.a, inputs.b));
    }
  }

  function changeInput(part: "a" | "b", raw: string) {
    const next = { ...inputs, [part]: raw };
    setInputs(next);
    const meta = operators.find((o) => o.id === operator);
    emit(operator, meta ? coerceValue(column.type, meta, next.a, next.b) : undefined);
  }

  function toggleValue(v: string) {
    const selected = currentSelected();
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    emit(operator, next.length ? next : undefined);
  }

  const useValueList = isValueListMode(operator);
  const selectedValues = currentSelected();
  const pickerOptions = (() => {
    const set = new Set<string>(authoritativeValues ?? onScreenValues);
    for (const v of selectedValues) set.add(v);
    return [...set].sort((a, b) => a.localeCompare(b));
  })();

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
        onChange={(e) => changeOperator(e.target.value)}
        className="rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none focus:border-stamp"
      >
        <option value="">no filter</option>
        {operators.map((o) => (
          <option key={o.id} value={o.id}>
            {o.label}
          </option>
        ))}
      </select>
      {useValueList ? (
        <ValueMultiSelect
          options={pickerOptions}
          selected={selectedValues}
          reconciling={authoritativeValues === null}
          onToggle={toggleValue}
        />
      ) : operatorMeta?.requiresValue ? (
        <input
          type={inputType}
          value={inputs.a}
          onChange={(e) => changeInput("a", e.target.value)}
          placeholder="value"
          className="w-28 rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none placeholder:text-ink-mute focus:border-stamp"
        />
      ) : operatorMeta?.requiresRange ? (
        <>
          <input
            type={inputType}
            value={inputs.a}
            onChange={(e) => changeInput("a", e.target.value)}
            placeholder="min"
            className="w-24 rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none placeholder:text-ink-mute focus:border-stamp"
          />
          <span className="text-ink-soft">and</span>
          <input
            type={inputType}
            value={inputs.b}
            onChange={(e) => changeInput("b", e.target.value)}
            placeholder="max"
            className="w-24 rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none placeholder:text-ink-mute focus:border-stamp"
          />
        </>
      ) : null}
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

/** The multi-select over a low-cardinality Text field's real distinct values
 * (ticket #38). Candidate values are seeded from the rows on screen and
 * reconciled with the discovery RPC — while that's in flight, `reconciling`
 * shows a subtle hint but the on-screen candidates stay pickable. */
function ValueMultiSelect({
  options,
  selected,
  reconciling,
  onToggle,
}: {
  options: string[];
  selected: string[];
  reconciling: boolean;
  onToggle: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const label =
    selected.length === 0
      ? "select values"
      : selected.length === 1
        ? selected[0]
        : `${selected.length} selected`;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex max-w-[10rem] items-center gap-1 rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none hover:border-ink-soft focus:border-stamp"
      >
        <span className={cn("truncate", selected.length === 0 && "text-ink-mute")}>{label}</span>
        <ChevronDown size={12} className="shrink-0 text-ink-soft" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => setOpen(false)} />
          <div className="absolute left-0 top-full z-30 mt-1 w-56 rounded-lg border border-rule bg-card p-1.5 shadow-lg">
            {reconciling && (
              <p className="px-1.5 py-1 text-[11px] text-ink-soft/70">Loading values…</p>
            )}
            {options.length === 0 ? (
              <p className="px-1.5 py-1 text-xs text-ink-soft/70">No values on this page.</p>
            ) : (
              <ul className="flex max-h-56 flex-col gap-0.5 overflow-y-auto">
                {options.map((v) => {
                  const checked = selected.includes(v);
                  return (
                    <li key={v}>
                      <button
                        type="button"
                        onClick={() => onToggle(v)}
                        className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs text-ink hover:bg-hover"
                      >
                        <span
                          className={cn(
                            "flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border",
                            checked ? "border-stamp bg-stamp text-white" : "border-rule"
                          )}
                        >
                          {checked && <Check size={10} />}
                        </span>
                        <span className="truncate" title={v}>
                          {v}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}
