"use client";

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";
import { EmailStatusBadge } from "@/components/people/email-status-badge";

/** Email value + verification badge + a "reverify" button, for a single record
 * detail page. Owns the status locally so the badge updates in place on success
 * without a full page refresh. Shared by the person and company record pages —
 * only the `endpoint` differs. */
export function ReverifyEmail({
  endpoint,
  email,
  initialStatus,
  initialVerifiedAt = null,
}: {
  endpoint: string;
  email: string | null;
  initialStatus: string | null;
  initialVerifiedAt?: string | null;
}) {
  const [status, setStatus] = useState<string | null>(initialStatus);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(initialVerifiedAt);
  const [busy, setBusy] = useState(false);

  async function handleReverify() {
    if (busy || !email) return;
    setBusy(true);
    try {
      const response = await fetch(endpoint, { method: "POST" });
      const data = await response.json().catch(() => null);
      // 202 is a legitimate outcome, not a failure — Icypeas verification is
      // async, and `!response.ok` only means an actual error.
      if (!response.ok) {
        throw new Error(data?.error ?? "Reverify failed");
      }
      setStatus(data.emailStatus);

      // Icypeas is async (submit -> webhook, see lib/verify/reverify.ts): in
      // production this call returns immediately with `pending: true` and no
      // verdict yet — the row shows "verifying" until the webhook resolves it
      // (a later page load/refresh picks up the final status). Local dev with
      // no public webhook URL configured resolves inline as before.
      if (data.pending) {
        showToast("Email verification submitted — check back shortly.", "info");
        return;
      }

      setVerifiedAt(data.emailVerifiedAt ?? new Date().toISOString());
      const creditNote =
        typeof data.credits === "number"
          ? ` (${data.credits.toLocaleString("en-US")} credits left)`
          : "";
      showToast(`Email reverified: ${data.emailStatus}${creditNote}.`, "success");
    } catch (err) {
      showToast((err as Error).message || "Reverify failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {email ?? "—"}
      <EmailStatusBadge email={email} status={status} verifiedAt={verifiedAt} />
      {email && (
        <button
          type="button"
          onClick={handleReverify}
          disabled={busy}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border border-rule px-2 py-0.5 text-[11px] font-medium transition-smooth",
            busy
              ? "cursor-not-allowed opacity-50"
              : "text-ink-soft hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-stamp/50"
          )}
          aria-label="Reverify email"
        >
          {busy ? (
            <Loader2 size={12} className="animate-spin" />
          ) : (
            <RefreshCw size={12} />
          )}
          {busy ? "Verifying…" : "Reverify"}
        </button>
      )}
    </span>
  );
}
