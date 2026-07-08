"use client";

import { useActionState, useEffect } from "react";
import { Loader2 } from "lucide-react";
import { login, type LoginState } from "./actions";

export function LoginForm() {
  const [state, action, pending] = useActionState<LoginState | undefined, FormData>(
    login,
    undefined
  );

  // Warm the server-side caches (dashboard + people/companies full-table scans)
  // while the user is signing in, so the first authenticated page loads without
  // waiting on a cold DB scan. Fire-and-forget: failures are irrelevant here.
  useEffect(() => {
    fetch("/api/warm").catch(() => {});
  }, []);

  return (
    <form action={action} className="flex flex-col gap-4">
      <input
        type="email"
        name="email"
        placeholder="Email"
        autoComplete="email"
        required
        autoFocus
        className="rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
      />
      <input
        type="password"
        name="password"
        placeholder="Password"
        autoComplete="current-password"
        required
        className="rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
      />
      {state?.error && <p className="text-xs text-red-500">{state.error}</p>}
      <button
        type="submit"
        disabled={pending}
        className="flex items-center justify-center gap-2 rounded-lg bg-stamp px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
      >
        {pending && <Loader2 size={15} className="animate-spin" />}
        Sign in
      </button>
    </form>
  );
}
