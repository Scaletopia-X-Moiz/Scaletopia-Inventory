/** The GHL "Last activity" filter contract: URL params in, filter shape out.
 *
 * Modeled on lib/data/push-status-filter.ts — same all-or-nothing parse, same
 * "a filter is only active once it's complete" rule, same
 * parse/build/label/payload quartet. The difference is that this one is
 * People-only: last activity is a property of a GHL *contact*, and only
 * people are pushed to GHL as contacts, so there is no companies counterpart
 * to keep in lockstep (unlike push status, which exists on both).
 *
 * Like push status, it is scoped to one client: a person can be pushed to
 * several GHL sub-accounts and "their last activity" is only a question you
 * can answer once you say which one. */

export type LastActivityOp = "empty" | "not_empty" | "between" | "within_days";

export interface LastActivityFilterBase {
  clientId: string;
}

export type LastActivityFilter =
  | (LastActivityFilterBase & { op: "empty" | "not_empty" })
  /** ISO dates (yyyy-mm-dd from the date inputs, widened to whole days by
   * the parser). At least one bound must be present. */
  | (LastActivityFilterBase & { op: "between"; from: string | null; to: string | null })
  | (LastActivityFilterBase & { op: "within_days"; days: number });

export const LAST_ACTIVITY_OP_LABELS: Record<LastActivityOp, string> = {
  empty: "Is empty",
  not_empty: "Is not empty",
  between: "Between",
  within_days: "Within last N days",
};

/** URL params. Prefixed `activity` so they can't collide with the push-status
 * trio (`pushClient`/`pushPlatform`/`pushStatus`) a user may have set at the
 * same time. */
export const LAST_ACTIVITY_PARAMS = [
  "activityClient",
  "activityOp",
  "activityFrom",
  "activityTo",
  "activityDays",
] as const;

function asOp(value: string | null): LastActivityOp | undefined {
  return value === "empty" || value === "not_empty" || value === "between" || value === "within_days"
    ? value
    : undefined;
}

/** Widens a `yyyy-mm-dd` to the instant that bound means, so "between Jan 1
 * and Jan 31" includes everything that happened ON Jan 31. A value that
 * already carries a time is passed through untouched. Anything unparseable
 * becomes null, which the predicate treats as "no bound on this side" —
 * degrade-gracefully, matching how every other filter parser here handles
 * junk in the URL. */
function asBoundary(value: string | null, edge: "start" | "end"): string | null {
  if (!value) return null;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value);
  const iso = dateOnly ? `${value}${edge === "start" ? "T00:00:00.000Z" : "T23:59:59.999Z"}` : value;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** Assembles a complete filter, or undefined. Each operator has its own
 * completeness rule: `between` needs at least one bound (a range with neither
 * end is just "not empty" spelled expensively), `within_days` needs a
 * positive day count. */
export function buildLastActivityFilter(
  clientId: string | undefined,
  op: LastActivityOp | undefined,
  raw: { from?: string | null; to?: string | null; days?: number | null } = {}
): LastActivityFilter | undefined {
  if (!clientId || !op) return undefined;
  if (op === "empty" || op === "not_empty") return { clientId, op };
  if (op === "between") {
    const from = asBoundary(raw.from ?? null, "start");
    const to = asBoundary(raw.to ?? null, "end");
    if (!from && !to) return undefined;
    return { clientId, op, from, to };
  }
  const days = raw.days ?? null;
  if (days == null || !Number.isFinite(days) || days <= 0) return undefined;
  return { clientId, op, days: Math.floor(days) };
}

export function parseLastActivityFilter(sp: URLSearchParams): LastActivityFilter | undefined {
  const daysRaw = sp.get("activityDays");
  const days = daysRaw != null && daysRaw !== "" ? Number(daysRaw) : null;
  return buildLastActivityFilter(sp.get("activityClient") ?? undefined, asOp(sp.get("activityOp")), {
    from: sp.get("activityFrom"),
    to: sp.get("activityTo"),
    days: days != null && Number.isFinite(days) ? days : null,
  });
}

/** Human-readable active label, e.g. "Last activity within last 60 days for
 * Acme" — the same shape pushStatusFilterLabel produces. */
export function lastActivityFilterLabel(filter: LastActivityFilter, clientName: string): string {
  const what = (() => {
    switch (filter.op) {
      case "empty":
        return "Last activity is empty";
      case "not_empty":
        return "Last activity is not empty";
      case "within_days":
        return `Last activity within last ${filter.days} day${filter.days === 1 ? "" : "s"}`;
      case "between": {
        const day = (iso: string | null) => (iso ? iso.slice(0, 10) : null);
        const from = day(filter.from);
        const to = day(filter.to);
        if (from && to) return `Last activity between ${from} and ${to}`;
        if (from) return `Last activity after ${from}`;
        return `Last activity before ${to}`;
      }
    }
  })();
  return `${what} for ${clientName}`;
}
