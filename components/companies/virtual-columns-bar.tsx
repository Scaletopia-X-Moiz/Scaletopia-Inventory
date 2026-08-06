"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Check, ChevronDown, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  ADDABLE_ENRICHMENT_TYPES,
  isLowCardinalityTextField,
  operatorsForType,
  sanitizeFilterSet,
  serializeVirtualFiltersParam,
  type ActiveVirtualColumn,
  type FilterCombinator,
  type VirtualColumnFilter,
  type VirtualColumnOperator,
  type VirtualColumnOperatorMeta,
  type VirtualColumnType,
  type VirtualFilterSet,
} from "@/lib/data/virtual-columns";

type EnrichmentFieldType = "Text" | "Number" | "Boolean" | "List" | "Date";

interface EnrichmentField {
  key: string;
  type: EnrichmentFieldType;
  sampleValues: string[];
}

/** One shared enrichment-field discovery for the whole bar: the "Add column"
 * picker and every filter condition's column/value picker read the same
 * discovered fields (and their authoritative `sampleValues`) instead of each
 * fetching their own. Loads lazily on first need (`ensureLoaded`) and reloads
 * only when the *native* filter scope changes — page/vc/vf are stripped from
 * the scope key, so adding a column or editing a condition never re-fires
 * discovery (that's what keeps the pickers stable and edits instant). */
function useEnrichmentFields(endpoint: string) {
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
    fetch(`${endpoint}?${scopeKey}`)
      .then((r) => {
        if (!r.ok) throw new Error(r.status.toString());
        return r.json() as Promise<{ fields: EnrichmentField[] }>;
      })
      .then((data) => setState({ scope: scopeKey, fields: data.fields, loading: false }))
      .catch(() => setState({ scope: scopeKey, fields: [], loading: false }));
  }, [scopeKey, endpoint]);

  return { fields, loading, ensureLoaded };
}

/** "Add column from enrichment" (the `vc` display-column set) plus the grouped
 * AND/OR filter builder (the `vf` set, ticket #117). The active-column set and
 * the grouped filter set are read from the `vc`/`vf` URL params (mirrored into
 * a ~1hr client cache) and owned by the caller via `useVirtualColumnsState()`,
 * passed in as props so `CompaniesResultsClient` can also react to them — e.g.
 * to offer removing the temporary columns after a Clay push (ticket #40).
 *
 * Display columns and filter conditions are independent since #117 (the same
 * column can appear in several conditions across groups, and a column can be
 * shown without a filter or filtered without being shown) — the display chips
 * only add/remove `vc` entries; all filtering lives in the builder popover.
 *
 * `onScreenValues[key]` carries the distinct values already rendered for each
 * column on the current page, so a Text `is` value picker can show candidates
 * instantly while the discovery RPC resolves the fuller, authoritative set
 * (ticket #38). */
export function VirtualColumnsBar({
  activeColumns,
  activeFilterSet,
  addColumn,
  removeColumn,
  setFilterSet,
  onScreenValues = {},
  endpoint = "/api/companies/enrichment-fields",
}: {
  activeColumns: ActiveVirtualColumn[];
  activeFilterSet: VirtualFilterSet | undefined;
  addColumn: (key: string, type: VirtualColumnType) => void;
  removeColumn: (key: string) => void;
  setFilterSet: (next: VirtualFilterSet | undefined) => void;
  onScreenValues?: Record<string, string[]>;
  /** Enrichment-field discovery endpoint — defaults to Companies; People
   * passes "/api/people/enrichment-fields" (ticket #41). */
  endpoint?: string;
}) {
  const { fields, loading, ensureLoaded } = useEnrichmentFields(endpoint);

  const conditionCount = useMemo(
    () => (activeFilterSet?.groups ?? []).reduce((n, g) => n + g.conditions.length, 0),
    [activeFilterSet]
  );

  return (
    <div className="flex flex-wrap items-center gap-2">
      {activeColumns.map((col) => (
        <DisplayColumnChip key={col.key} column={col} onRemove={() => removeColumn(col.key)} />
      ))}
      <AddColumnButton
        fields={fields}
        loading={loading}
        ensureLoaded={ensureLoaded}
        onAdd={addColumn}
        addedKeys={activeColumns.map((c) => c.key)}
      />
      <FilterBuilderButton
        activeFilterSet={activeFilterSet}
        setFilterSet={setFilterSet}
        fields={fields}
        loading={loading}
        ensureLoaded={ensureLoaded}
        onScreenValues={onScreenValues}
        conditionCount={conditionCount}
      />
    </div>
  );
}

/** A display-only virtual column (the `vc` param): a labelled chip with a
 * remove control. No filter editing lives here anymore (#117 moved all
 * filtering into the grouped builder). */
function DisplayColumnChip({ column, onRemove }: { column: ActiveVirtualColumn; onRemove: () => void }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-rule bg-card px-2 py-1.5 text-xs">
      <span className="font-medium text-ink" title={column.key}>
        {column.key}
      </span>
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
    <FilterPopoverButton open={open} onOpenChange={setOpen} label="Add column">
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
 * state (so selecting a field can close it). `width` widens the panel for the
 * grouped filter builder. */
function FilterPopoverButton({
  open,
  onOpenChange,
  label,
  badge,
  width = "w-72",
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  label: string;
  badge?: number;
  width?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => onOpenChange(!open)}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md border border-dashed border-rule bg-card px-3 py-1.5 text-sm hover:border-ink-soft hover:text-ink",
          badge ? "border-stamp/40 text-ink" : "text-ink-soft"
        )}
      >
        <Plus size={14} />
        {label}
        {badge ? (
          <span className="rounded-full bg-stamp/15 px-1.5 text-xs font-medium text-stamp">{badge}</span>
        ) : null}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => onOpenChange(false)} />
          <div
            className={cn(
              "absolute left-0 top-full z-30 mt-1.5 rounded-lg border border-rule bg-card p-3 shadow-lg",
              width
            )}
          >
            {children}
          </div>
        </>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------------- *
 * Grouped filter builder (ticket #117)
 *
 * The URL/`vf` set can only ever carry *valid* conditions (the parser drops
 * anything malformed), but the builder must let a user pick a column, then an
 * operator, then type a value — an inherently incomplete intermediate state.
 * So the builder keeps a local *draft* (conditions may be half-filled) seeded
 * from the committed set, and on every edit pushes the sanitized subset (only
 * complete conditions, empty groups dropped) to the URL via setFilterSet. The
 * draft retains in-progress rows so the UI doesn't lose the row being filled.
 * ------------------------------------------------------------------------- */

let nextDraftId = 0;
function draftId(): string {
  nextDraftId += 1;
  return `d${nextDraftId}`;
}

interface DraftCondition {
  id: string;
  key: string;
  type: VirtualColumnType | "";
  operator: string;
  value?: VirtualColumnFilter["value"];
}
interface DraftGroup {
  id: string;
  combinator: FilterCombinator;
  conditions: DraftCondition[];
}
interface DraftSet {
  combinator: FilterCombinator;
  groups: DraftGroup[];
}

function emptyCondition(): DraftCondition {
  return { id: draftId(), key: "", type: "", operator: "" };
}

function emptyDraft(): DraftSet {
  return { combinator: "and", groups: [{ id: draftId(), combinator: "and", conditions: [emptyCondition()] }] };
}

function setToDraft(set: VirtualFilterSet | undefined): DraftSet {
  if (!set || set.groups.length === 0) return emptyDraft();
  return {
    combinator: set.combinator,
    groups: set.groups.map((g) => ({
      id: draftId(),
      combinator: g.combinator,
      conditions: g.conditions.length
        ? g.conditions.map((c) => ({ id: draftId(), key: c.key, type: c.type, operator: c.operator, value: c.value }))
        : [emptyCondition()],
    })),
  };
}

/** Reduces a draft (with possibly-incomplete conditions) to a validated
 * VirtualFilterSet by round-tripping through the shared param sanitizer, which
 * drops malformed conditions and empty groups exactly as a URL parse would. */
function draftToSet(draft: DraftSet): VirtualFilterSet | undefined {
  return sanitizeFilterSet({
    combinator: draft.combinator,
    groups: draft.groups.map((g) => ({
      combinator: g.combinator,
      conditions: g.conditions.map((c) => ({ key: c.key, type: c.type, operator: c.operator, value: c.value })),
    })),
  });
}

function FilterBuilderButton({
  activeFilterSet,
  setFilterSet,
  fields,
  loading,
  ensureLoaded,
  onScreenValues,
  conditionCount,
}: {
  activeFilterSet: VirtualFilterSet | undefined;
  setFilterSet: (next: VirtualFilterSet | undefined) => void;
  fields: EnrichmentField[] | null;
  loading: boolean;
  ensureLoaded: () => void;
  onScreenValues: Record<string, string[]>;
  conditionCount: number;
}) {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (open) ensureLoaded();
  }, [open, ensureLoaded]);

  const committedSig = serializeVirtualFiltersParam(activeFilterSet) ?? "";
  const [draft, setDraft] = useState<DraftSet>(() => setToDraft(activeFilterSet));
  // The signature of the set we last pushed, so the reseed effect below can
  // tell an *external* change to `vf` (removeColumn, clearAll, navigation)
  // apart from an echo of our own push and only reseed for the former —
  // otherwise every push would wipe the half-filled row being edited.
  const lastPushedSig = useRef(committedSig);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (committedSig !== lastPushedSig.current) {
      setDraft(setToDraft(activeFilterSet));
      lastPushedSig.current = committedSig;
    }
    // Only the committed signature should trigger a reseed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [committedSig]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  /** Applies a draft edit: updates the local draft immediately (responsive
   * inputs) and pushes the sanitized set to the URL — debounced for free-text
   * value typing (ticket #115), immediate for structural edits (add/remove,
   * operator/column/combinator, chip and multi-select toggles). */
  const commit = useCallback(
    (nextDraft: DraftSet, opts?: { debounce?: boolean }) => {
      setDraft(nextDraft);
      const next = draftToSet(nextDraft);
      const push = () => {
        lastPushedSig.current = serializeVirtualFiltersParam(next) ?? "";
        setFilterSet(next);
      };
      if (debounceRef.current) clearTimeout(debounceRef.current);
      if (opts?.debounce) {
        debounceRef.current = setTimeout(push, 300);
      } else {
        debounceRef.current = null;
        push();
      }
    },
    [setFilterSet]
  );

  const updateGroup = useCallback(
    (groupId: string, fn: (g: DraftGroup) => DraftGroup, opts?: { debounce?: boolean }) => {
      commit({ ...draft, groups: draft.groups.map((g) => (g.id === groupId ? fn(g) : g)) }, opts);
    },
    [commit, draft]
  );

  return (
    <FilterPopoverButton open={open} onOpenChange={setOpen} label="Filters" badge={conditionCount} width="w-[30rem]">
      <div className="flex flex-col gap-2">
        {draft.groups.map((group, gi) => (
          <div key={group.id}>
            {gi > 0 && (
              <div className="flex justify-center py-1">
                <CombinatorToggle
                  value={draft.combinator}
                  onChange={(c) => commit({ ...draft, combinator: c })}
                />
              </div>
            )}
            <GroupEditor
              group={group}
              fields={fields}
              loading={loading}
              onScreenValues={onScreenValues}
              onChangeCombinator={(c) => updateGroup(group.id, (g) => ({ ...g, combinator: c }))}
              onChangeCondition={(condId, next, opts) =>
                updateGroup(
                  group.id,
                  (g) => ({ ...g, conditions: g.conditions.map((c) => (c.id === condId ? next : c)) }),
                  opts
                )
              }
              onAddCondition={() =>
                updateGroup(group.id, (g) => ({ ...g, conditions: [...g.conditions, emptyCondition()] }))
              }
              onRemoveCondition={(condId) => {
                const remaining = group.conditions.filter((c) => c.id !== condId);
                if (remaining.length === 0) {
                  // Removing a group's last condition removes the whole group,
                  // unless it's the only group left (keep one empty group so
                  // the builder never renders blank).
                  if (draft.groups.length === 1) {
                    commit({ ...draft, groups: [{ ...group, conditions: [emptyCondition()] }] });
                  } else {
                    commit({ ...draft, groups: draft.groups.filter((g) => g.id !== group.id) });
                  }
                } else {
                  updateGroup(group.id, (g) => ({ ...g, conditions: remaining }));
                }
              }}
              onRemoveGroup={
                draft.groups.length > 1
                  ? () => commit({ ...draft, groups: draft.groups.filter((g) => g.id !== group.id) })
                  : undefined
              }
            />
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            commit({
              ...draft,
              groups: [...draft.groups, { id: draftId(), combinator: "and", conditions: [emptyCondition()] }],
            })
          }
          className="mt-1 inline-flex w-fit items-center gap-1.5 rounded-md border border-dashed border-rule bg-card px-2.5 py-1.5 text-xs text-ink-soft hover:border-ink-soft hover:text-ink"
        >
          <Plus size={13} />
          Add group
        </button>
      </div>
    </FilterPopoverButton>
  );
}

/** The two-way AND/OR pill toggle used both between groups (top-level
 * combinator) and between conditions (group combinator). */
function CombinatorToggle({
  value,
  onChange,
}: {
  value: FilterCombinator;
  onChange: (value: FilterCombinator) => void;
}) {
  return (
    <div className="inline-flex overflow-hidden rounded border border-rule text-[11px] font-medium">
      {(["and", "or"] as const).map((c) => (
        <button
          key={c}
          type="button"
          onClick={() => onChange(c)}
          className={cn(
            "px-2 py-0.5 uppercase",
            value === c ? "bg-stamp text-white" : "bg-card text-ink-soft hover:text-ink"
          )}
        >
          {c}
        </button>
      ))}
    </div>
  );
}

function GroupEditor({
  group,
  fields,
  loading,
  onScreenValues,
  onChangeCombinator,
  onChangeCondition,
  onAddCondition,
  onRemoveCondition,
  onRemoveGroup,
}: {
  group: DraftGroup;
  fields: EnrichmentField[] | null;
  loading: boolean;
  onScreenValues: Record<string, string[]>;
  onChangeCombinator: (value: FilterCombinator) => void;
  onChangeCondition: (condId: string, next: DraftCondition, opts?: { debounce?: boolean }) => void;
  onAddCondition: () => void;
  onRemoveCondition: (condId: string) => void;
  onRemoveGroup?: () => void;
}) {
  return (
    <div className="rounded-lg border border-rule bg-paper/40 p-2">
      <div className="flex flex-col gap-1.5">
        {group.conditions.map((cond, ci) => (
          <div key={cond.id} className="flex items-start gap-1.5">
            <div className="min-w-[4.5rem] shrink-0 pt-1.5">
              {ci === 0 ? (
                <span className="text-[11px] text-ink-soft/70">Where</span>
              ) : (
                <CombinatorToggle value={group.combinator} onChange={onChangeCombinator} />
              )}
            </div>
            <ConditionEditor
              condition={cond}
              fields={fields}
              loading={loading}
              onScreenValues={onScreenValues}
              onChange={(next, opts) => onChangeCondition(cond.id, next, opts)}
              onRemove={() => onRemoveCondition(cond.id)}
            />
          </div>
        ))}
      </div>
      <div className="mt-2 flex items-center justify-between">
        <button
          type="button"
          onClick={onAddCondition}
          className="inline-flex items-center gap-1 text-xs text-ink-soft hover:text-ink"
        >
          <Plus size={12} />
          Add condition
        </button>
        {onRemoveGroup && (
          <button
            type="button"
            onClick={onRemoveGroup}
            className="text-xs text-ink-soft/70 hover:text-ink"
          >
            Remove group
          </button>
        )}
      </div>
    </div>
  );
}

const INPUT_TYPE: Record<VirtualColumnType, "text" | "number" | "date"> = {
  text: "text",
  number: "number",
  boolean: "text",
  list: "text",
  date: "date",
};

/** The raw input strings a condition's value control holds (`a` for a single
 * value / range low end, `b` for a range high end). Kept as strings (what the
 * DOM inputs produce) and coerced to the typed value at edit time. */
function initialInputs(value: VirtualColumnFilter["value"] | undefined): { a: string; b: string } {
  if (Array.isArray(value)) return { a: String(value[0] ?? ""), b: String(value[1] ?? "") };
  if (value == null) return { a: "", b: "" };
  return { a: String(value), b: "" };
}

/** Coerces the raw input string(s) into the typed value, or `undefined` when
 * incomplete/invalid (so the condition stays uncommitted rather than pushing a
 * half-formed value). Numbers parse to real numbers; dates stay ISO strings. */
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

function ConditionEditor({
  condition,
  fields,
  loading,
  onScreenValues,
  onChange,
  onRemove,
}: {
  condition: DraftCondition;
  fields: EnrichmentField[] | null;
  loading: boolean;
  onScreenValues: Record<string, string[]>;
  onChange: (next: DraftCondition, opts?: { debounce?: boolean }) => void;
  onRemove: () => void;
}) {
  const [inputs, setInputs] = useState(() => initialInputs(condition.value));

  // Reseed the raw inputs when the committed value changes underneath us (e.g.
  // an external reseed of the whole draft), keyed on a stable serialization so
  // typing (which updates `condition.value` too) doesn't fight the local state.
  const valueSig = JSON.stringify(condition.value ?? null);
  useEffect(() => {
    setInputs(initialInputs(condition.value));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [valueSig]);

  const addableFields = (fields ?? []).filter((f) => f.type in ADDABLE_ENRICHMENT_TYPES);
  const columnType = condition.type || null;
  const operators = columnType ? operatorsForType(columnType) : [];
  const operatorMeta = operators.find((o) => o.id === condition.operator);
  const inputType = columnType ? INPUT_TYPE[columnType] : "text";

  const authoritativeValues =
    columnType === "text" && fields !== null
      ? (fields.find((f) => f.key === condition.key)?.sampleValues ?? [])
      : null;
  const screen = onScreenValues[condition.key] ?? [];

  function isValueListMode(op: string): boolean {
    if (columnType !== "text" || (op !== "is" && op !== "is_not")) return false;
    if (authoritativeValues === null) return screen.length > 0;
    return isLowCardinalityTextField(authoritativeValues);
  }
  function isChipInputMode(op: string): boolean {
    return (columnType === "text" || columnType === "list") && (op === "contains" || op === "not_contains");
  }

  function currentSelected(): string[] {
    if (Array.isArray(condition.value)) return condition.value as string[];
    if (typeof condition.value === "string") return [condition.value];
    return [];
  }

  function changeColumn(key: string) {
    const field = addableFields.find((f) => f.key === key);
    const type = field ? ADDABLE_ENRICHMENT_TYPES[field.type] : "";
    // A new column resets the operator/value — its operators (and value arity)
    // differ by type.
    onChange({ ...condition, key, type, operator: "", value: undefined });
  }

  function emitOperator(op: string, value: VirtualColumnFilter["value"] | undefined) {
    onChange({ ...condition, operator: op, value });
  }

  function changeOperator(op: string) {
    if (!columnType) return;
    const meta = operators.find((o) => o.id === op);
    if (!op || !meta) {
      emitOperator("", undefined);
      return;
    }
    if (!meta.requiresValue && !meta.requiresRange) {
      emitOperator(op, undefined);
      return;
    }
    if (isValueListMode(op) || isChipInputMode(op)) {
      const selected = currentSelected();
      emitOperator(op, selected.length ? selected : undefined);
    } else {
      emitOperator(op, coerceValue(columnType, meta, inputs.a, inputs.b));
    }
  }

  function changeInput(part: "a" | "b", raw: string) {
    const next = { ...inputs, [part]: raw };
    setInputs(next);
    if (!columnType || !operatorMeta) return;
    onChange(
      { ...condition, value: coerceValue(columnType, operatorMeta, next.a, next.b) },
      { debounce: true }
    );
  }

  function flushInput() {
    if (!columnType || !operatorMeta) return;
    onChange({ ...condition, value: coerceValue(columnType, operatorMeta, inputs.a, inputs.b) });
  }

  function addChip(v: string) {
    const trimmed = v.trim();
    if (!trimmed) return;
    const selected = currentSelected();
    if (selected.includes(trimmed)) return;
    emitOperator(condition.operator, [...selected, trimmed]);
  }
  function removeChip(v: string) {
    const next = currentSelected().filter((x) => x !== v);
    emitOperator(condition.operator, next.length ? next : undefined);
  }
  function removeLastChip() {
    const selected = currentSelected();
    if (selected.length === 0) return;
    const next = selected.slice(0, -1);
    emitOperator(condition.operator, next.length ? next : undefined);
  }
  function toggleValue(v: string) {
    const selected = currentSelected();
    const next = selected.includes(v) ? selected.filter((x) => x !== v) : [...selected, v];
    emitOperator(condition.operator, next.length ? next : undefined);
  }

  const useValueList = isValueListMode(condition.operator);
  const useChipInput = isChipInputMode(condition.operator);
  const selectedValues = currentSelected();
  const pickerOptions = (() => {
    const set = new Set<string>(authoritativeValues ?? screen);
    for (const v of selectedValues) set.add(v);
    return [...set].sort((a, b) => a.localeCompare(b));
  })();

  return (
    <div className="flex flex-1 flex-wrap items-center gap-1.5 rounded-md border border-rule bg-card px-2 py-1.5 text-xs">
      <select
        value={condition.key}
        onChange={(e) => changeColumn(e.target.value)}
        className="max-w-[9rem] rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none focus:border-stamp"
      >
        <option value="">
          {loading && fields === null ? "loading…" : "select field"}
        </option>
        {/* Keep a stale column selectable even if discovery no longer lists it. */}
        {condition.key && !addableFields.some((f) => f.key === condition.key) && (
          <option value={condition.key}>{condition.key}</option>
        )}
        {addableFields.map((f) => (
          <option key={f.key} value={f.key}>
            {f.key}
          </option>
        ))}
      </select>
      {columnType && (
        <select
          value={condition.operator}
          onChange={(e) => changeOperator(e.target.value)}
          className="rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none focus:border-stamp"
        >
          <option value="">operator</option>
          {operators.map((o) => (
            <option key={o.id} value={o.id}>
              {o.label}
            </option>
          ))}
        </select>
      )}
      {columnType && useValueList ? (
        <ValueMultiSelect
          options={pickerOptions}
          selected={selectedValues}
          reconciling={authoritativeValues === null}
          onToggle={toggleValue}
        />
      ) : columnType && useChipInput ? (
        <ChipValueInput chips={selectedValues} onAdd={addChip} onRemove={removeChip} onRemoveLast={removeLastChip} />
      ) : operatorMeta?.requiresValue ? (
        <input
          type={inputType}
          value={inputs.a}
          onChange={(e) => changeInput("a", e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && flushInput()}
          onBlur={flushInput}
          placeholder="value"
          className="w-28 rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none placeholder:text-ink-mute focus:border-stamp"
        />
      ) : operatorMeta?.requiresRange ? (
        <>
          <input
            type={inputType}
            value={inputs.a}
            onChange={(e) => changeInput("a", e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && flushInput()}
            onBlur={flushInput}
            placeholder="min"
            className="w-20 rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none placeholder:text-ink-mute focus:border-stamp"
          />
          <span className="text-ink-soft">and</span>
          <input
            type={inputType}
            value={inputs.b}
            onChange={(e) => changeInput("b", e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && flushInput()}
            onBlur={flushInput}
            placeholder="max"
            className="w-20 rounded border border-rule bg-card px-1.5 py-1 text-ink outline-none placeholder:text-ink-mute focus:border-stamp"
          />
        </>
      ) : null}
      <button
        type="button"
        aria-label="Remove condition"
        onClick={onRemove}
        className="ml-auto text-ink-soft hover:text-ink"
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

/** Clay-style multi-value keyword input for Text/List contains/not_contains
 * (ticket #116): type a keyword, press Enter to turn it into a removable
 * chip, repeat to stack several. Backspace on an empty draft pops the last
 * chip; each chip also has its own × button. Chips commit immediately (no
 * debounce, unlike the free-text inputs) since Enter is already a discrete
 * "add" action — there's no per-keystroke churn to coalesce. */
function ChipValueInput({
  chips,
  onAdd,
  onRemove,
  onRemoveLast,
}: {
  chips: string[];
  onAdd: (value: string) => void;
  onRemove: (value: string) => void;
  onRemoveLast: () => void;
}) {
  const [draft, setDraft] = useState("");

  function commitDraft() {
    if (!draft.trim()) return;
    onAdd(draft);
    setDraft("");
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commitDraft();
    } else if (e.key === "Backspace" && draft === "" && chips.length > 0) {
      onRemoveLast();
    }
  }

  return (
    <div className="flex max-w-[14rem] flex-wrap items-center gap-1 rounded border border-rule bg-card px-1.5 py-1 focus-within:border-stamp">
      {chips.map((chip) => (
        <span
          key={chip}
          className="inline-flex items-center gap-1 rounded bg-hover px-1.5 py-0.5 text-ink"
        >
          <span className="max-w-[8rem] truncate" title={chip}>
            {chip}
          </span>
          <button
            type="button"
            aria-label={`Remove ${chip}`}
            onClick={() => onRemove(chip)}
            className="text-ink-soft hover:text-ink"
          >
            <X size={10} />
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
        onBlur={commitDraft}
        placeholder={chips.length === 0 ? "value, Enter to add" : "add another…"}
        className="min-w-[5rem] flex-1 bg-transparent text-ink outline-none placeholder:text-ink-mute"
      />
    </div>
  );
}
