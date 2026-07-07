"use client";

import { useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";
import { PhoneStatusBadge } from "@/components/people/phone-status-badge";
import { PhoneTypeBadge } from "@/components/people/phone-type-badge";

/** Phone value + verification badge + a "reverify" button, for a single record
 * detail page. Owns the status/type locally so the badges update in place on
 * success without a full page refresh. Shared by the person and company record
 * pages — only the `endpoint` differs. Mirrors ReverifyEmail; no "credits
 * left" messaging since ClearoutPhone doesn't report a running balance. */
export function ReverifyPhone({
  endpoint,
  phone,
  initialStatus,
  initialVerifiedAt = null,
  initialType = null,
}: {
  endpoint: string;
  phone: string | null;
  initialStatus: string | null;
  initialVerifiedAt?: string | null;
  initialType?: string | null;
}) {
  const [status, setStatus] = useState<string | null>(initialStatus);
  const [verifiedAt, setVerifiedAt] = useState<string | null>(initialVerifiedAt);
  const [type, setType] = useState<string | null>(initialType);
  const [busy, setBusy] = useState(false);

  async function handleReverify() {
    if (busy || !phone) return;
    setBusy(true);
    try {
      const response = await fetch(endpoint, { method: "POST" });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(data?.error ?? "Reverify failed");
      }
      setStatus(data.phoneStatus);
      setType(data.phoneType ?? null);
      setVerifiedAt(data.phoneVerifiedAt ?? new Date().toISOString());
      showToast(`Phone reverified: ${data.phoneStatus}.`, "success");
    } catch (err) {
      showToast((err as Error).message || "Reverify failed.", "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      {phone ?? "—"}
      <PhoneTypeBadge phone={phone} type={type} />
      <PhoneStatusBadge phone={phone} status={status} verifiedAt={verifiedAt} />
      {phone && (
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
          aria-label="Reverify phone"
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
