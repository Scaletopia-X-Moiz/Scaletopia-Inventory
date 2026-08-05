import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { listClientOptions } from "@/lib/data/clients";
import { listPushJobs } from "@/lib/data/push-jobs";
import { PushActivityView } from "./push-activity-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Push Activity · Scaletopia Inventory" };

const PAGE_SIZE = 50;

export default async function PushActivityPage() {
  const [{ rows, total }, clients] = await Promise.all([
    listPushJobs({}, PAGE_SIZE, 0),
    listClientOptions(),
  ]);

  return (
    <AppShell>
      <Topbar section="Pages" page="Push Activity" />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <h1 className="mb-1 text-xl font-semibold text-ink">Push activity</h1>
          <p className="mb-6 text-sm text-ink-soft">
            Every push to GHL or EmailBison — queued, running, and completed — updating live.
          </p>
          <PushActivityView
            rows={rows}
            initialHasMore={rows.length < total}
            clients={clients}
          />
        </div>
      </main>
    </AppShell>
  );
}
