import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { requireAdminOrDev } from "@/lib/auth/dal";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { TeamView, type Member } from "./team-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Team · Scaletopia Databank" };

export default async function TeamPage() {
  const admin = await requireAdminOrDev();

  const { data } = await supabaseAdmin
    .from("profiles")
    .select("id, email, role, created_at")
    .order("created_at", { ascending: true });

  const members = (data ?? []) as Member[];

  return (
    <AppShell>
      <Topbar section="Admin" page="Team" />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <h1 className="mb-1 text-xl font-semibold text-ink">Team</h1>
          <p className="mb-6 text-sm text-ink-soft">
            Invite people by email and manage access. Invited users set their own
            password from the email link.
          </p>
          <TeamView members={members} currentUserId={admin.id} />
        </div>
      </main>
    </AppShell>
  );
}
