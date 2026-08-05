"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { Search } from "lucide-react";
import { FilterChipGroup, type ChipOption } from "@/components/companies/filter-chip-group";
import { FilterPopover } from "@/components/shared/filter-popover";
import { SingleSelectGroup } from "@/components/people/single-select-group";
import { PushJobFilterChip } from "@/components/shared/push-job-filter-chip";
import type { CompanyFilterOptions } from "@/lib/data/companies";

const MULTI_PARAMS = [
  "niche",
  "source",
  "industry",
  "employee",
  "country",
  "emailStatus",
  "phoneType",
] as const;
const SINGLE_PARAMS = ["q", "empmin", "empmax"] as const;

export function FilterSlip({ options }: { options: CompanyFilterOptions }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [, startTransition] = useTransition();
  const [search, setSearch] = useState(searchParams.get("q") ?? "");
  const [empMin, setEmpMin] = useState(searchParams.get("empmin") ?? "");
  const [empMax, setEmpMax] = useState(searchParams.get("empmax") ?? "");

  // Free-text search navigates on every keystroke, which fires an RSC
  // round-trip per character while typing (issue #91 — a third of the
  // intermediate per-keystroke requests were observed 503ing, though the
  // final settled request always succeeds). Debouncing the commit — not the
  // input's own value, which stays instant — cuts that down to one request
  // per typing pause regardless of whether those intermediate requests are a
  // real server issue or a benign cancelled-prefetch artifact.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  function commitSearchDebounced(value: string) {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      commitSearch(value);
    }, 300);
  }

  function getAll(param: string): string[] {
    return searchParams.getAll(param);
  }

  function getExcluded(param: string): string[] {
    return searchParams.getAll(`${param}_exclude`);
  }

  function facetCount(param: string): number {
    return getAll(param).length + getExcluded(param).length;
  }

  function navigate(mutate: (params: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    params.delete("page");
    startTransition(() => {
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    });
  }

  function removeValue(params: URLSearchParams, param: string, id: string) {
    const current = params.getAll(param);
    if (!current.includes(id)) return;
    params.delete(param);
    for (const value of current) if (value !== id) params.append(param, value);
  }

  function toggleInclude(param: string, id: string) {
    navigate((params) => {
      removeValue(params, `${param}_exclude`, id);
      const current = params.getAll(param);
      params.delete(param);
      const next = current.includes(id) ? current.filter((v) => v !== id) : [...current, id];
      for (const value of next) params.append(param, value);
    });
  }

  function toggleExclude(param: string, id: string) {
    navigate((params) => {
      removeValue(params, param, id);
      const excludeParam = `${param}_exclude`;
      const current = params.getAll(excludeParam);
      params.delete(excludeParam);
      const next = current.includes(id) ? current.filter((v) => v !== id) : [...current, id];
      for (const value of next) params.append(excludeParam, value);
    });
  }

  function commitSearch(value: string) {
    navigate((params) => {
      if (value.trim()) params.set("q", value.trim());
      else params.delete("q");
    });
  }

  function commitCustomRange(min: string, max: string) {
    navigate((params) => {
      if (min.trim()) params.set("empmin", min.trim());
      else params.delete("empmin");
      if (max.trim()) params.set("empmax", max.trim());
      else params.delete("empmax");
      // clear bucket selection when custom range is used
      if (min.trim() || max.trim()) params.delete("employee");
    });
  }

  function setSingleSelect(param: string, id: string) {
    navigate((params) => {
      if (id === "any") params.delete(param);
      else params.set(param, id);
    });
  }

  function clearAll() {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setSearch("");
    setEmpMin("");
    setEmpMax("");
    startTransition(() => {
      router.replace(pathname, { scroll: false });
    });
  }

  const hasActiveFilters =
    Boolean(searchParams.get("q")) ||
    Boolean(searchParams.get("email")) ||
    Boolean(searchParams.get("phone")) ||
    Boolean(searchParams.get("empmin")) ||
    Boolean(searchParams.get("empmax")) ||
    Boolean(searchParams.get("pushJobId")) ||
    MULTI_PARAMS.some((p) => searchParams.getAll(p).length > 0 || searchParams.getAll(`${p}_exclude`).length > 0);

  const toOptions = (entries: { id: string; label: string; count: number }[]): ChipOption[] =>
    entries.map((e) => ({ id: e.id, label: e.label, count: e.count }));

  const presenceCount =
    (searchParams.get("email") ? 1 : 0) + (searchParams.get("phone") ? 1 : 0);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <PushJobFilterChip />
        <div className="relative flex-1 min-w-[220px] max-w-sm">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-soft" />
          <input
            type="text"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              commitSearchDebounced(e.target.value);
            }}
            placeholder="Search name or domain"
            className="w-full rounded-md border border-rule bg-card py-1.5 pl-8 pr-3 text-sm text-ink outline-none placeholder:text-ink-soft/70 focus:border-stamp"
          />
        </div>

        <FilterPopover label="Niche" count={facetCount("niche")}>
          <FilterChipGroup
            title="Niche"
            options={toOptions(options.niches)}
            selected={getAll("niche")}
            excluded={getExcluded("niche")}
            onToggle={(id) => toggleInclude("niche", id)}
            onToggleExclude={(id) => toggleExclude("niche", id)}
          />
        </FilterPopover>
        <FilterPopover label="Source" count={facetCount("source")}>
          <FilterChipGroup
            title="Source"
            options={toOptions(options.sources)}
            selected={getAll("source")}
            excluded={getExcluded("source")}
            onToggle={(id) => toggleInclude("source", id)}
            onToggleExclude={(id) => toggleExclude("source", id)}
          />
        </FilterPopover>
        <FilterPopover label="Industry" count={facetCount("industry")}>
          <FilterChipGroup
            title="Industry"
            options={toOptions(options.industries)}
            selected={getAll("industry")}
            excluded={getExcluded("industry")}
            onToggle={(id) => toggleInclude("industry", id)}
            onToggleExclude={(id) => toggleExclude("industry", id)}
          />
        </FilterPopover>
        <FilterPopover label="Employee size" count={getAll("employee").length + (searchParams.get("empmin") || searchParams.get("empmax") ? 1 : 0)}>
          <FilterChipGroup
            title="Employee size"
            options={options.employeeBuckets.map((b) => ({ id: b.id, label: b.label }))}
            selected={getAll("employee")}
            onToggle={(id) => {
              setEmpMin("");
              setEmpMax("");
              navigate((params) => {
                params.delete("empmin");
                params.delete("empmax");
                const current = params.getAll("employee");
                params.delete("employee");
                const next = current.includes(id) ? current.filter((v) => v !== id) : [...current, id];
                for (const value of next) params.append("employee", value);
              });
            }}
          />
          <div className="mt-3 border-t border-rule pt-3">
            <p className="mb-2 text-xs font-medium text-ink-mute">Custom range</p>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={0}
                placeholder="Min"
                value={empMin}
                onChange={(e) => {
                  setEmpMin(e.target.value);
                  commitCustomRange(e.target.value, empMax);
                }}
                className="w-20 rounded border border-rule bg-card px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-mute focus:border-stamp"
              />
              <span className="text-xs text-ink-mute">–</span>
              <input
                type="number"
                min={0}
                placeholder="Max"
                value={empMax}
                onChange={(e) => {
                  setEmpMax(e.target.value);
                  commitCustomRange(empMin, e.target.value);
                }}
                className="w-20 rounded border border-rule bg-card px-2 py-1 text-xs text-ink outline-none placeholder:text-ink-mute focus:border-stamp"
              />
            </div>
          </div>
        </FilterPopover>
        <FilterPopover label="Country" count={facetCount("country")}>
          <FilterChipGroup
            title="Country"
            options={toOptions(options.countries)}
            selected={getAll("country")}
            excluded={getExcluded("country")}
            onToggle={(id) => toggleInclude("country", id)}
            onToggleExclude={(id) => toggleExclude("country", id)}
          />
        </FilterPopover>
        <FilterPopover label="Email status" count={facetCount("emailStatus")}>
          <FilterChipGroup
            title="Email status"
            options={toOptions(options.emailStatuses)}
            selected={getAll("emailStatus")}
            excluded={getExcluded("emailStatus")}
            onToggle={(id) => toggleInclude("emailStatus", id)}
            onToggleExclude={(id) => toggleExclude("emailStatus", id)}
          />
        </FilterPopover>
        <FilterPopover label="Phone type" count={facetCount("phoneType")}>
          <FilterChipGroup
            title="Phone type"
            options={toOptions(options.phoneTypes)}
            selected={getAll("phoneType")}
            excluded={getExcluded("phoneType")}
            onToggle={(id) => toggleInclude("phoneType", id)}
            onToggleExclude={(id) => toggleExclude("phoneType", id)}
          />
        </FilterPopover>
        <FilterPopover label="Has contact info" count={presenceCount}>
          <div className="flex flex-col gap-4">
            <SingleSelectGroup
              title="Email"
              value={searchParams.get("email") ?? "any"}
              onChange={(id) => setSingleSelect("email", id)}
            />
            <SingleSelectGroup
              title="Phone"
              value={searchParams.get("phone") ?? "any"}
              onChange={(id) => setSingleSelect("phone", id)}
            />
          </div>
        </FilterPopover>

        <button
          type="button"
          onClick={clearAll}
          disabled={!hasActiveFilters}
          className="text-xs text-stamp underline-offset-2 hover:underline disabled:opacity-30 disabled:cursor-not-allowed disabled:no-underline"
        >
          Clear all
        </button>
      </div>
    </div>
  );
}
