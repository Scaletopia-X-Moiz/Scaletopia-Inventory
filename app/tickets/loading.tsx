import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { Skeleton } from "@/components/ui/skeleton";

export default function Loading() {
  return (
    <AppShell>
      <Topbar section="Pages" page="Tickets" />
      <main className="flex-1 overflow-x-hidden overflow-y-auto px-5 py-6 md:px-7">
        <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-6">
          <div className="flex items-center justify-between gap-3">
            <div className="flex flex-col gap-2">
              <Skeleton className="h-6 w-28 rounded animate-shimmer" />
              <Skeleton className="h-4 w-64 rounded animate-shimmer animate-in-delay-1" />
            </div>
            <Skeleton className="h-9 w-32 rounded-lg animate-shimmer animate-in-delay-2" />
          </div>

          <div className="flex gap-2">
            <Skeleton className="h-8 w-16 rounded-full animate-shimmer animate-in-delay-2" />
            <Skeleton className="h-8 w-16 rounded-full animate-shimmer animate-in-delay-3" />
            <Skeleton className="h-8 w-14 rounded-full animate-shimmer animate-in-delay-4" />
          </div>

          <Skeleton className="h-[420px] rounded-xl animate-shimmer animate-in-delay-4" />
        </div>
      </main>
    </AppShell>
  );
}
