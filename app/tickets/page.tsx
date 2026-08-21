import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { requireUser } from "@/lib/auth/dal";
import { getTickets, type TicketTab } from "@/lib/data/tickets";
import { TicketTabs } from "@/components/tickets/ticket-tabs";
import { TicketsList } from "@/components/tickets/tickets-list";
import { CreateTicketDialog } from "@/components/tickets/create-ticket-dialog";

export const dynamic = "force-dynamic";
export const metadata = { title: "Tickets · Scaletopia Databank" };

function parseTab(value: string | undefined): TicketTab {
  return value === "done" || value === "all" ? value : "open";
}

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>;
}) {
  const user = await requireUser();
  const { tab: rawTab } = await searchParams;
  const tab = parseTab(rawTab);

  const tickets = await getTickets({ tab }, user.role, user.id);

  return (
    <AppShell>
      <Topbar section="Pages" page="Tickets" />
      <main className="flex-1 overflow-x-hidden overflow-y-auto px-5 py-6 md:px-7">
        <div className="mx-auto flex w-full max-w-3xl min-w-0 flex-col gap-6">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h1 className="text-xl font-semibold text-ink">Tickets</h1>
              <p className="mt-1 text-sm text-ink-soft">
                {user.role === "member"
                  ? "Bugs, feature requests, and improvements you've reported."
                  : "Bugs, feature requests, and improvements across the team."}
              </p>
            </div>
            <CreateTicketDialog />
          </div>

          <TicketTabs active={tab} />

          <TicketsList tickets={tickets} viewerRole={user.role} viewerId={user.id} />
        </div>
      </main>
    </AppShell>
  );
}
