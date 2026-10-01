/** How the People table's refresh dialog reports what the enqueue endpoint
 * did. Pure, and in its own module rather than in the button, so the rules
 * can be unit-tested without rendering a dialog — the rules ARE the bug this
 * file was written for (see `refreshOutcomeToast`). */
import type { ToastType } from "@/components/shared/toast";

export type RefreshPlanMode = "ids" | "filtered" | "all_pushed";

/** What the enqueue endpoint actually returns. `skippedClients` and `message`
 * are not decoration: a sub-account with no GHL credentials is dropped from
 * the fan-out, and a refresh that reports "12 people across 1 sub-account" in
 * green while silently abandoning 38 people in four others is how someone
 * comes to trust a column that was never refreshed. */
export interface RefreshResult {
  jobIds: string[];
  clientCount: number;
  /** For `all_pushed` this is a SUM over sub-accounts, not distinct people —
   * nothing names the people, so two co-located sub-accounts sharing 100
   * people report 200. The toast says so rather than calling it "200 people". */
  personCount: number;
  mode?: RefreshPlanMode;
  estimatedCalls: number;
  skippedClients?: { clientId: string; name: string | null; reason: string }[];
  /** Present when the server resolved nothing to do — an outcome, not an error. */
  message?: string;
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** The toast for a completed enqueue: what it says, and what colour it is.
 *
 * Exported and pure so the rules can be tested, because the rules are the
 * bug. Three outcomes the previous version collapsed into one green
 * "Refreshing N people across M sub-accounts":
 *
 *  - nothing queued because nothing was pushed — information, neutral;
 *  - nothing queued because every sub-account was skipped — not a success,
 *    and the reasons are the whole message;
 *  - some queued, some skipped — the skipped ones are named, because the
 *    people in them are NOT being refreshed and nothing else will say so.
 *
 * Zero jobs is never a success toast. */
export function refreshOutcomeToast(
  result: RefreshResult,
  nameFor: (clientId: string) => string
): [message: string, type: ToastType] {
  const skipped = result.skippedClients ?? [];
  const skippedText =
    skipped.length > 0
      ? `${skipped.length} ${plural(skipped.length, "sub-account was", "sub-accounts were")} skipped — ` +
        skipped.map((s) => `${s.name ?? nameFor(s.clientId)}: ${s.reason}`).join("; ")
      : null;

  if (result.jobIds.length === 0) {
    if (skippedText) return [`Nothing was refreshed. ${skippedText}`, "error"];
    return [
      result.message ??
        "Nothing to refresh — none of those people have been pushed to a GHL sub-account.",
      "info",
    ];
  }

  const subAccounts = `${result.clientCount} ${plural(result.clientCount, "sub-account", "sub-accounts")}`;
  const cost = `~${result.estimatedCalls.toLocaleString("en-US")} GHL ${plural(result.estimatedCalls, "call", "calls")}`;
  const queued =
    result.mode === "all_pushed"
      ? `Refreshing every contact ${subAccounts} ${plural(result.clientCount, "has", "have")} pushed — ` +
        `${result.personCount.toLocaleString("en-US")} in total, counted once per sub-account (${cost})`
      : `Refreshing ${result.personCount.toLocaleString("en-US")} ` +
        `${plural(result.personCount, "person", "people")} across ${subAccounts} (${cost})`;

  if (!skippedText) return [`${queued} — track it in Push Activity`, "success"];
  // Deliberately NOT green: part of what the user asked for is not happening.
  return [`${queued} — track it in Push Activity. But ${skippedText}`, "error"];
}

