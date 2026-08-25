"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AlertDialog } from "radix-ui";
import type { CompanyListResult } from "@/lib/data/companies";
import { virtualColumnIdentity } from "@/lib/data/virtual-columns";
import { CompaniesTable } from "@/components/companies/companies-table";
import { VirtualColumnsBar } from "@/components/companies/virtual-columns-bar";
import { useVirtualColumnsState } from "@/components/companies/use-virtual-columns";
import { Pagination } from "@/components/companies/pagination";
import { ExportButton } from "@/components/companies/export-button";
import { PushToClayButton } from "@/components/companies/push-to-clay-button";
import { PushToEmailBisonButton } from "@/components/companies/push-to-emailbison-button";
import { PushToEmailBisonCampaignButton } from "@/components/companies/push-to-emailbison-campaign-button";
import { CleanNamesButton } from "@/components/companies/clean-names-button";
import { ReverifyFilteredButton } from "@/components/shared/reverify-filtered-button";
import { SkeletonTable } from "@/components/shared/skeleton-loaders";
import { isAnyDialogOpen, subscribeToDialogStack } from "@/components/shared/dialog-stack";

const cache = new Map<string, CompanyListResult>();

export function CompaniesResultsClient() {
  const searchParams = useSearchParams();
  const paramsStr = searchParams.toString();
  const hit = cache.get(paramsStr) ?? null;
  const [result, setResult] = useState<CompanyListResult | null>(hit);
  const [loading, setLoading] = useState(hit === null);
  const [error, setError] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    const cached = cache.get(paramsStr);
    if (cached) {
      setResult(cached);
      setLoading(false);
    } else {
      setLoading(true);
      setError(false);
    }

    fetch(`/api/companies/results?${paramsStr}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data: CompanyListResult) => {
        cache.set(paramsStr, data);
        setResult(data);
        setLoading(false);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          setLoading(false);
          setError(true);
        }
      });
  }, [paramsStr]);

  useEffect(() => {
    load();
    return () => abortRef.current?.abort();
  }, [load]);

  const {
    activeColumns: virtualColumns,
    activeFilterSet: virtualFilterSet,
    addColumn: addVirtualColumn,
    removeColumn: removeVirtualColumn,
    setFilterSet: setVirtualFilterSet,
    clearAll: clearVirtualColumns,
  } = useVirtualColumnsState();

  // After a Clay push completes, offer to remove any active virtual columns
  // (ticket #40) — a no-op prompt if none are active.
  const [showRemoveColumnsPrompt, setShowRemoveColumnsPrompt] = useState(false);
  // A push's `onDone` can fire while that push button's own dialog is still
  // showing its "Push complete" summary (EmailBison/EmailBison Campaign) —
  // opening this prompt right away would stack it on top and obscure the
  // summary (issue #89). If something else is open when onDone fires, defer
  // via pendingRemovePromptRef and open once the dialog stack notifies us it
  // has drained, rather than opening unconditionally.
  const pendingRemovePromptRef = useRef(false);
  const handlePushDone = useCallback(() => {
    if (virtualColumns.length === 0) return;
    if (isAnyDialogOpen()) {
      pendingRemovePromptRef.current = true;
    } else {
      setShowRemoveColumnsPrompt(true);
    }
  }, [virtualColumns.length]);
  useEffect(() => {
    return subscribeToDialogStack(() => {
      if (pendingRemovePromptRef.current && !isAnyDialogOpen()) {
        pendingRemovePromptRef.current = false;
        setShowRemoveColumnsPrompt(true);
      }
    });
  }, []);

  /** Distinct values already on screen per virtual column — the instant seed
   * the Text `is` value picker shows before the discovery RPC resolves the
   * fuller, authoritative set (ticket #38). */
  const onScreenValues = useMemo(() => {
    const acc: Record<string, Set<string>> = {};
    for (const col of virtualColumns) acc[virtualColumnIdentity(col.source, col.key, "company")] = new Set<string>();
    for (const row of result?.rows ?? []) {
      for (const col of virtualColumns) {
        const identity = virtualColumnIdentity(col.source, col.key, "company");
        const v = row.virtualColumnValues?.[identity];
        if (typeof v === "string") {
          const t = v.trim();
          if (t) acc[identity].add(t);
        } else if (typeof v === "number" || typeof v === "boolean") {
          acc[identity].add(String(v));
        }
      }
    }
    return Object.fromEntries(Object.entries(acc).map(([k, s]) => [k, [...s]]));
  }, [result, virtualColumns]);

  const exportHref = `/companies/export?${paramsStr}`;

  if (loading) {
    return (
      <div className="flex flex-col gap-6">
        <div className="h-4 w-36 rounded bg-rule animate-pulse" />
        <SkeletonTable rows={12} />
      </div>
    );
  }

  if (error || !result) {
    return (
      <p className="text-sm text-ink-soft">Failed to load companies. Please refresh.</p>
    );
  }

  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">
          {result.total.toLocaleString("en-US")} companies
        </h2>
        <div className="flex items-center gap-2">
          <ReverifyFilteredButton
            endpoint="/api/companies/reverify"
            paramsStr={paramsStr}
            total={result.total}
            noun="companies"
            fieldLabel="email"
            onDone={load}
          />
          <CleanNamesButton paramsStr={paramsStr} total={result.total} onDone={load} />
          <PushToClayButton paramsStr={paramsStr} total={result.total} onDone={handlePushDone} />
          <PushToEmailBisonButton
            paramsStr={paramsStr}
            total={result.total}
            virtualColumns={virtualColumns}
            onDone={handlePushDone}
          />
          <PushToEmailBisonCampaignButton
            paramsStr={paramsStr}
            total={result.total}
            virtualColumns={virtualColumns}
            onDone={handlePushDone}
          />
          <ExportButton href={exportHref} />
        </div>
      </div>

      <VirtualColumnsBar
        activeColumns={virtualColumns}
        activeFilterSet={virtualFilterSet}
        addColumn={addVirtualColumn}
        removeColumn={removeVirtualColumn}
        setFilterSet={setVirtualFilterSet}
        onScreenValues={onScreenValues}
        endpoint="/api/enrichment-fields"
        selfEntity="company"
      />

      <CompaniesTable rows={result.rows} virtualColumns={virtualColumns} />

      <Pagination
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        searchParams={new URLSearchParams(paramsStr)}
      />

      <AlertDialog.Root open={showRemoveColumnsPrompt} onOpenChange={setShowRemoveColumnsPrompt}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
          <AlertDialog.Content className="fixed top-[28%] left-1/2 z-50 w-full max-w-sm -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Remove temporary columns?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              The push finished. {virtualColumns.length} enrichment{" "}
              {virtualColumns.length === 1 ? "column is" : "columns are"} still active on this
              view — remove {virtualColumns.length === 1 ? "it" : "them"} now, or keep{" "}
              {virtualColumns.length === 1 ? "it" : "them"} until they expire.
            </AlertDialog.Description>
            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className="rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink transition-smooth hover:bg-hover focus-visible:ring-2 focus-visible:ring-stamp/50"
                >
                  No, keep them
                </button>
              </AlertDialog.Cancel>
              <button
                type="button"
                onClick={() => {
                  clearVirtualColumns();
                  setShowRemoveColumnsPrompt(false);
                }}
                className="rounded-md bg-stamp px-3 py-1.5 text-xs font-medium text-white transition-smooth hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stamp/50"
              >
                Yes, remove
              </button>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </>
  );
}
