import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { requireAdminOrDev } from "@/lib/auth/dal";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ActivityView, type ActivityRow } from "./activity-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Activity · Scaletopia Inventory" };

export default async function ActivityPage() {
  await requireAdminOrDev();

  const PAGE_SIZE = 200;
  const { data } = await supabaseAdmin
    .from("activity_log")
    .select("id, user_email, action, details, created_at")
    .order("created_at", { ascending: false })
    .limit(PAGE_SIZE);

  const rows = (data ?? []) as ActivityRow[];
  const initialHasMore = rows.length === PAGE_SIZE;

  return (
    <AppShell>
      <Topbar section="Admin" page="Activity" />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <h1 className="mb-1 text-xl font-semibold text-ink">Activity log</h1>
          <p className="mb-6 text-sm text-ink-soft">
            Who did what, most recent first.
          </p>
          <ActivityView rows={rows} initialHasMore={initialHasMore} />
        </div>
      </main>
    </AppShell>
  );
}
