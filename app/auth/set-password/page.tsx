"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import { createSupabaseBrowserClient } from "@/lib/supabase/client";
import { ScaletopiaLogo } from "@/components/shared/scaletopia-logo";
import { confirmInviteAccepted } from "@/app/auth/actions";

/**
 * Landing page for invite / password-reset links. The Supabase browser client
 * detects the token in the URL and establishes a session automatically; the
 * invited user then chooses their password.
 */
export default function SetPasswordPage() {
  const [ready, setReady] = useState(false);
  const [linkValid, setLinkValid] = useState(true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const supabase = createSupabaseBrowserClient();
    // Give detectSessionInUrl a tick to consume the token, then confirm we
    // have a session.
    supabase.auth.getSession().then(({ data }) => {
      setLinkValid(Boolean(data.session));
      setReady(true);
    });
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    if (password !== confirm) {
      setError("Passwords do not match.");
      return;
    }
    setSaving(true);
    const supabase = createSupabaseBrowserClient();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) {
      setError(error.message);
      setSaving(false);
      return;
    }
    // Best-effort: record that the invite was accepted. Never blocks the
    // redirect — logActivity itself swallows its own errors.
    try {
      await confirmInviteAccepted();
    } catch {
      // ignore — logging must never block onboarding
    }
    // Full reload so the server sees the fresh session cookie.
    window.location.href = "/";
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-paper px-4">
      <div className="w-full max-w-sm rounded-xl border border-rule bg-card p-8 shadow-xl">
        <ScaletopiaLogo className="mb-6 h-7 w-auto text-ink" />
        <h1 className="mb-1 text-lg font-semibold text-ink">Set your password</h1>

        {!ready ? (
          <p className="mt-4 flex items-center gap-2 text-sm text-ink-soft">
            <Loader2 size={15} className="animate-spin" /> Verifying invite…
          </p>
        ) : !linkValid ? (
          <p className="mt-4 text-sm text-red-500">
            This invite link is invalid or has expired. Ask an admin to send a
            new one.
          </p>
        ) : (
          <>
            <p className="mb-6 text-sm text-ink-soft">
              Choose a password to finish setting up your account.
            </p>
            <form onSubmit={submit} className="flex flex-col gap-4">
              <input
                type="password"
                placeholder="New password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                autoFocus
                className="rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
              />
              <input
                type="password"
                placeholder="Confirm password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                autoComplete="new-password"
                className="rounded-lg border border-rule bg-paper px-3 py-2 text-sm text-ink outline-none focus:border-stamp"
              />
              {error && <p className="text-xs text-red-500">{error}</p>}
              <button
                type="submit"
                disabled={saving}
                className="flex items-center justify-center gap-2 rounded-lg bg-stamp px-4 py-2 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:opacity-60"
              >
                {saving && <Loader2 size={15} className="animate-spin" />}
                Save password
              </button>
            </form>
          </>
        )}
      </div>
    </div>
  );
}
