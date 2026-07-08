import { redirect } from "next/navigation";
import { ScaletopiaLogo } from "@/components/shared/scaletopia-logo";
import { getUser } from "@/lib/auth/dal";
import { LoginForm } from "./login-form";

export const metadata = { title: "Sign in · Scaletopia Inventory" };

export default async function LoginPage() {
  if (await getUser()) redirect("/");

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="w-full max-w-sm rounded-xl border border-rule bg-card p-8 shadow-xl">
        <ScaletopiaLogo className="mb-6 h-7 w-auto text-ink" />
        <h1 className="mb-1 text-lg font-semibold text-ink">Sign in</h1>
        <p className="mb-6 text-sm text-ink-soft">
          Use your Scaletopia Inventory account.
        </p>
        <LoginForm />
      </div>
    </div>
  );
}
