import { Suspense } from "react";
import { getDashboard } from "@/lib/data/dashboard";
import { parseDashboardRange } from "@/lib/data/dashboard-search-params";
import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { StatCard } from "@/components/dashboard/stat-card";
import { AreaChart } from "@/components/dashboard/area-chart";
import { BarChart } from "@/components/dashboard/bar-chart";
import { DonutChart } from "@/components/dashboard/donut-chart";
import { MiniBarList } from "@/components/dashboard/mini-bar-list";
import { RecentTable } from "@/components/dashboard/recent-table";
import { DateRangePicker } from "@/components/dashboard/date-range-picker";
import { SkeletonCard, SkeletonChart, SkeletonTable } from "@/components/shared/skeleton-loaders";

export const revalidate = 3600;

async function DashboardSections({ from, to }: { from?: string; to?: string }) {
  const data = await getDashboard({ from, to });

  return (
    <>
      <section className="space-y-3">
        <p className="text-xs font-semibold text-ink-mute uppercase tracking-widest">Key Metrics</p>
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
          <StatCard label="Companies" value={data.totalCompanies} variant="blue" icon="companies" href="/companies" />
          <StatCard label="People" value={data.totalPeople} variant="plain" icon="people" href="/people" />
          <StatCard label="Niches" value={data.niches.length} variant="plain" icon="niches" />
          <StatCard label="Sources" value={data.sources.length} variant="purple" icon="sources" />
          <StatCard label="Pushes" value={data.totalPushes} variant="plain" icon="pushes" href="/push-history" />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-xs font-semibold text-ink-mute uppercase tracking-widest">Data Distribution</p>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <AreaChart
              title="Catalog Distribution"
              series={[
                { key: "niches", label: "By Niche", points: data.niches },
                { key: "sources", label: "By Source", points: data.sources },
              ]}
            />
          </div>
          <MiniBarList title="Sources" entries={data.sources} filterParam="source" />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-xs font-semibold text-ink-mute uppercase tracking-widest">Market Breakdown</p>
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <BarChart title="Top Industries" entries={data.industries} filterParam="industry" />
          <DonutChart title="Geography" entries={data.countries} filterParam="country" />
        </div>
      </section>

      <section className="space-y-3">
        <p className="text-xs font-semibold text-ink-mute uppercase tracking-widest">Recent Activity</p>
        <RecentTable title="Recently Added Companies" rows={data.recentCompanies} />
      </section>
    </>
  );
}

function DashboardSkeleton() {
  return (
    <>
      <section className="space-y-3">
        <div className="h-3 w-24 rounded bg-rule animate-pulse" />
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-5">
          {[...Array(5)].map((_, i) => <SkeletonCard key={i} />)}
        </div>
      </section>
      <section className="space-y-3">
        <div className="h-3 w-32 rounded bg-rule animate-pulse" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <SkeletonChart className="lg:col-span-2" />
          <SkeletonChart />
        </div>
      </section>
      <section className="space-y-3">
        <div className="h-3 w-28 rounded bg-rule animate-pulse" />
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <SkeletonChart />
          <SkeletonChart />
        </div>
      </section>
      <section className="space-y-3">
        <div className="h-3 w-28 rounded bg-rule animate-pulse" />
        <SkeletonTable rows={5} />
      </section>
    </>
  );
}

export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const resolved = await searchParams;
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(resolved)) {
    if (Array.isArray(value)) value.forEach((v) => params.append(key, v));
    else if (value !== undefined) params.append(key, value);
  }
  const range = parseDashboardRange(params);

  return (
    <AppShell>
      <Topbar section="Dashboards" page="Overview" />

      <main className="flex-1 overflow-x-hidden overflow-y-auto">
        <div className="px-5 py-6 md:px-7">
          <div className="mx-auto flex w-full max-w-[920px] min-w-0 flex-col gap-8">
            <div className="flex items-center justify-between">
              <h1 className="text-2xl font-bold text-ink">Analytics Overview</h1>
              <DateRangePicker />
            </div>

            <Suspense fallback={<DashboardSkeleton />}>
              <DashboardSections from={range.from} to={range.to} />
            </Suspense>
          </div>
        </div>
      </main>
    </AppShell>
  );
}
