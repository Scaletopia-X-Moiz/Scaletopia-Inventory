import { Suspense } from "react";
import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { FilterSlipLoader } from "@/components/companies/filter-slip-loader";
import { CompaniesResultsClient } from "@/components/companies/companies-results-client";
import { SkeletonTable } from "@/components/shared/skeleton-loaders";

export default function CompaniesPage() {
  return (
    <AppShell>
      <Topbar section="Pages" page="Companies" />

      <main className="flex-1 overflow-x-hidden overflow-y-auto px-5 py-6 md:px-7">
        <div className="flex w-full min-w-0 flex-col gap-6">
          <Suspense fallback={<div className="flex flex-wrap gap-2">{[...Array(5)].map((_, i) => <div key={i} className="h-8 w-24 rounded-md bg-rule animate-pulse" />)}</div>}>
            <FilterSlipLoader />
          </Suspense>

          <Suspense fallback={<div className="flex flex-col gap-6"><div className="h-4 w-36 rounded bg-rule animate-pulse" /><SkeletonTable rows={12} /></div>}>
            <CompaniesResultsClient />
          </Suspense>
        </div>
      </main>
    </AppShell>
  );
}
