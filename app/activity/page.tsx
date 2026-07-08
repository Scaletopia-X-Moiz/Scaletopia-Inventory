import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { requireAdmin } from "@/lib/auth/dal";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { ActivityView, type ActivityRow } from "./activity-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Activity · Scaletopia Inventory" };

export default async function ActivityPage() {
  await requireAdmin();

  const { data } = await supabaseAdmin
    .from("activity_log")
    .select("id, user_email, action, details, created_at")
    .order("created_at", { ascending: false })
    .limit(200);

  const rows = (data ?? []) as ActivityRow[];

  return (
    <AppShell>
      <Topbar section="Admin" page="Activity" />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <h1 className="mb-1 text-xl font-semibold text-ink">Activity log</h1>
          <p className="mb-6 text-sm text-ink-soft">
            Who did what, most recent first. Shows the latest 200 events.
          </p>
          <ActivityView rows={rows} />
        </div>
      </main>
    </AppShell>
  );
}
