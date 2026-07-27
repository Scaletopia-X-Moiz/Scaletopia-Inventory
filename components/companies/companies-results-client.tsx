"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import type { CompanyListResult } from "@/lib/data/companies";
import { parseVirtualColumnsParam } from "@/lib/data/virtual-columns";
import { CompaniesTable } from "@/components/companies/companies-table";
import { VirtualColumnsBar } from "@/components/companies/virtual-columns-bar";
import { Pagination } from "@/components/companies/pagination";
import { ExportButton } from "@/components/companies/export-button";
import { PushToClayButton } from "@/components/companies/push-to-clay-button";
import { CleanNamesButton } from "@/components/companies/clean-names-button";
import { ReverifyFilteredButton } from "@/components/shared/reverify-filtered-button";
import { SkeletonTable } from "@/components/shared/skeleton-loaders";

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
          <PushToClayButton paramsStr={paramsStr} total={result.total} />
          <ExportButton href={exportHref} />
        </div>
      </div>

      <VirtualColumnsBar />

      <CompaniesTable rows={result.rows} virtualColumns={parseVirtualColumnsParam(searchParams)} />

      <Pagination
        page={result.page}
        pageSize={result.pageSize}
        total={result.total}
        searchParams={new URLSearchParams(paramsStr)}
      />
    </>
  );
}
