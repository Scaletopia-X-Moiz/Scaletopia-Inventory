"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FilterSlip } from "@/components/companies/filter-slip";

interface FilterOption {
  id: string;
  label: string;
  count: number;
}
interface CompanyFilterOptions {
  niches: FilterOption[];
  sources: FilterOption[];
  industries: FilterOption[];
  countries: FilterOption[];
  employeeBuckets: { id: string; label: string }[];
  [key: string]: unknown;
}

const EMPTY: CompanyFilterOptions = {
  niches: [],
  sources: [],
  industries: [],
  countries: [],
  employeeBuckets: [],
};

// Facet counts depend on the active filters (see getCompanyFilterOptions), so
// results are cached per unique query string rather than once globally.
const cache = new Map<string, CompanyFilterOptions>();

export function FilterSlipClient() {
  const searchParams = useSearchParams();
  const facetParams = new URLSearchParams(searchParams);
  facetParams.delete("page");
  const paramsStr = facetParams.toString();
  const [options, setOptions] = useState<CompanyFilterOptions>(cache.get(paramsStr) ?? EMPTY);

  useEffect(() => {
    const cached = cache.get(paramsStr);
    if (cached) {
      setOptions(cached);
      return;
    }

    const controller = new AbortController();
    fetch(`/api/companies/filter-options?${paramsStr}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(r.status.toString());
        return r.json() as Promise<CompanyFilterOptions>;
      })
      .then((data) => {
        cache.set(paramsStr, data);
        setOptions(data);
      })
      .catch((err) => {
        if (err.name !== "AbortError") {
          // keep showing the previous options rather than clearing the UI
        }
      });

    return () => controller.abort();
  }, [paramsStr]);

  return <FilterSlip options={options} />;
}
