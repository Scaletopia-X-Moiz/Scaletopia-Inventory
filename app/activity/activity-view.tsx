"use client";

import { timeAgo } from "@/lib/utils";

export interface ActivityRow {
  id: number;
  user_email: string | null;
  action: string;
  details: Record<string, unknown>;
  created_at: string;
}

const ACTION_LABELS: Record<string, string> = {
  "auth.login": "Signed in",
  "auth.logout": "Signed out",
  "import.run": "Ran import",
  "clay.push": "Pushed to Clay",
  "verify.reverify": "Reverified (bulk)",
  "verify.reverify_one": "Reverified record",
  "user.invite": "Invited user",
  "user.role_change": "Changed role",
};

function labelFor(action: string) {
  return ACTION_LABELS[action] ?? action;
}

/** Compact human summary of the details blob, tailored per action. */
function summarize(action: string, d: Record<string, unknown>): string {
  const parts: string[] = [];
  const push = (v: unknown) => v !== undefined && v !== null && parts.push(String(v));

  switch (action) {
    case "import.run":
      push(d.targetTable && `${d.targetTable}`);
      push(d.sourceKey && `from ${d.sourceKey}`);
      push(
        `${d.insertedCount ?? 0} new · ${d.updatedCount ?? 0} updated · ${d.failedCount ?? 0} failed`
      );
      break;
    case "clay.push":
      push(d.target);
      push(`${d.pushed ?? 0} pushed · ${d.errors ?? 0} errors`);
      break;
    case "verify.reverify":
      push(`${d.target} ${d.kind}`);
      push(`${d.verified ?? 0} verified · ${d.errors ?? 0} errors`);
      break;
    case "verify.reverify_one":
      push(`${d.target} ${d.kind}`);
      break;
    case "user.invite":
      push(d.email);
      break;
    case "user.role_change":
      push(d.email && `${d.email} → ${d.role}`);
      break;
  }
  return parts.filter(Boolean).join(" · ");
}

function fmtAbsolute(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

export function ActivityView({ rows }: { rows: ActivityRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-xl border border-rule bg-card p-8 text-center text-sm text-ink-soft">
        No activity recorded yet.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-rule bg-card">
      <table className="w-full min-w-[640px] text-sm">
        <thead>
          <tr className="border-b border-rule text-left text-xs text-ink-mute">
            <th className="px-4 py-3 font-medium">Who</th>
            <th className="px-4 py-3 font-medium">Action</th>
            <th className="px-4 py-3 font-medium">Details</th>
            <th className="px-4 py-3 font-medium">When</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-rule/60 last:border-0">
              <td className="px-4 py-3 text-ink">{r.user_email ?? "—"}</td>
              <td className="px-4 py-3">
                <span className="inline-flex items-center rounded bg-hover px-2 py-0.5 text-xs font-medium text-ink">
                  {labelFor(r.action)}
                </span>
              </td>
              <td className="px-4 py-3 text-ink-soft">
                {summarize(r.action, r.details ?? {}) || "—"}
              </td>
              <td className="whitespace-nowrap px-4 py-3 text-ink-soft" title={fmtAbsolute(r.created_at)}>
                {timeAgo(r.created_at)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
