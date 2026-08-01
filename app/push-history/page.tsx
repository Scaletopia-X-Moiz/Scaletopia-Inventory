import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { listClientOptions } from "@/lib/data/clients";
import { listPushHistory } from "@/lib/data/push-history";
import { PushHistoryView } from "./push-history-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Push History · Scaletopia Inventory" };

const PAGE_SIZE = 50;

export default async function PushHistoryPage() {
  const [{ rows, total }, clients] = await Promise.all([
    listPushHistory({}, PAGE_SIZE, 0),
    listClientOptions(),
  ]);

  return (
    <AppShell>
      <Topbar section="Pages" page="Push History" />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <h1 className="mb-1 text-xl font-semibold text-ink">Push history</h1>
          <p className="mb-6 text-sm text-ink-soft">
            Every record pushed to GHL or EmailBison, most recent first.
          </p>
          <PushHistoryView
            rows={rows}
            initialHasMore={rows.length < total}
            clients={clients}
          />
        </div>
      </main>
    </AppShell>
  );
}
