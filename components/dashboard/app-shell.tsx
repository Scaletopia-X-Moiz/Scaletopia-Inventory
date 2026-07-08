import { Sidebar } from "@/components/dashboard/sidebar";
import { SessionProvider } from "@/components/dashboard/session-context";
import { getUser } from "@/lib/auth/dal";

export async function AppShell({ children }: { children: React.ReactNode }) {
  const user = await getUser();
  const session = user ? { email: user.email, role: user.role } : null;

  return (
    <SessionProvider value={session}>
      <div className="flex h-screen overflow-hidden">
        <Sidebar />
        <div className="flex min-w-0 flex-1 flex-col">{children}</div>
      </div>
    </SessionProvider>
  );
}
