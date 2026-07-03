"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PeopleFilterSlip } from "@/components/people/filter-slip";

interface FilterOption {
  id: string;
  label: string;
  count: number;
}
interface PersonFilterOptions {
  niches: FilterOption[];
  sources: FilterOption[];
  countries: FilterOption[];
  industries: FilterOption[];
  employeeBuckets: { id: string; label: string }[];
  emailStatuses: FilterOption[];
  phoneTypes: FilterOption[];
}

const EMPTY: PersonFilterOptions = {
  niches: [],
  sources: [],
  countries: [],
  industries: [],
  employeeBuckets: [],
  emailStatuses: [],
  phoneTypes: [],
};

// Facet counts depend on the active filters (see getPersonFilterOptions), so
// results are cached per unique query string rather than once globally.
const cache = new Map<string, PersonFilterOptions>();

export function PeopleFilterSlipClient() {
  const searchParams = useSearchParams();
  const facetParams = new URLSearchParams(searchParams);
  facetParams.delete("page");
  const paramsStr = facetParams.toString();
  const [options, setOptions] = useState<PersonFilterOptions>(cache.get(paramsStr) ?? EMPTY);

  useEffect(() => {
    const cached = cache.get(paramsStr);
    if (cached) {
      setOptions(cached);
      return;
    }

    const controller = new AbortController();
    fetch(`/api/people/filter-options?${paramsStr}`, { signal: controller.signal })
      .then((r) => {
        if (!r.ok) throw new Error(r.status.toString());
        return r.json() as Promise<PersonFilterOptions>;
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

  return <PeopleFilterSlip options={options} />;
}
