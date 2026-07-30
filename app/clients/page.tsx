import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { requireAdminOrDev } from "@/lib/auth/dal";
import { listClients } from "@/lib/data/clients";
import { ClientsView } from "./clients-view";

export const dynamic = "force-dynamic";
export const metadata = { title: "Clients · Scaletopia Inventory" };

export default async function ClientsPage() {
  await requireAdminOrDev();
  const clients = await listClients();

  return (
    <AppShell>
      <Topbar section="Admin" page="Clients" />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-5xl">
          <h1 className="mb-1 text-xl font-semibold text-ink">Clients</h1>
          <p className="mb-6 text-sm text-ink-soft">
            GHL push credentials for each agency client. Edits save automatically.
          </p>
          <ClientsView clients={clients} />
        </div>
      </main>
    </AppShell>
  );
}
