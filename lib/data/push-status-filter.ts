/** Shared push-status filter contract for People and Companies.
 *
 * A single module so both entities read the same URL param names and run the
 * same validation — People and Companies can't diverge on `pushClient` vs some
 * other spelling, or accept a platform one side rejects. Foundation for the
 * Push Status Filters epic (#125): the predicate itself isn't evaluated here
 * (that's F2/P1/C1); this only parses the URL and shapes the RPC payload key. */

export type PushPlatform = "ghl" | "emailbison";
export type PushStatus = "pushed" | "not_pushed";

export interface PushStatusFilter {
  clientId: string;
  platform: PushPlatform;
  status: PushStatus;
}

function asPushPlatform(value: string | null): PushPlatform | undefined {
  return value === "ghl" || value === "emailbison" ? value : undefined;
}

function asPushStatus(value: string | null): PushStatus | undefined {
  return value === "pushed" || value === "not_pushed" ? value : undefined;
}

/** Only active when all three params are present & valid; else undefined.
 * Mirrors the single-select param style (asSingleSelect) for validity checks. */
export function parsePushStatusFilter(sp: URLSearchParams): PushStatusFilter | undefined {
  const clientId = sp.get("pushClient") ?? undefined;
  const platform = asPushPlatform(sp.get("pushPlatform"));
  const status = asPushStatus(sp.get("pushStatus"));
  return buildPushStatusFilter(clientId, platform, status);
}

/** Display labels for the shared push-status filter UI (see
 * PushStatusFilterPopover). Kept beside the type so People and Companies render
 * the same platform/status wording. */
export const PUSH_PLATFORM_LABELS: Record<PushPlatform, string> = {
  ghl: "GHL",
  emailbison: "EmailBison",
};

export const PUSH_STATUS_LABELS: Record<PushStatus, string> = {
  pushed: "Already pushed",
  not_pushed: "Not yet pushed",
};

/** Assembles a complete filter only when all three fields are set, else
 * undefined — the UI-draft mirror of parsePushStatusFilter's all-or-nothing
 * rule, so the popover emits the same shape the URL parser accepts. */
export function buildPushStatusFilter(
  clientId: string | undefined,
  platform: PushPlatform | undefined,
  status: PushStatus | undefined
): PushStatusFilter | undefined {
  if (!clientId || !platform || !status) return undefined;
  return { clientId, platform, status };
}

/** Human-readable active label, e.g. "Not yet pushed to GHL for Acme". */
export function pushStatusFilterLabel(filter: PushStatusFilter, clientName: string): string {
  return `${PUSH_STATUS_LABELS[filter.status]} to ${PUSH_PLATFORM_LABELS[filter.platform]} for ${clientName}`;
}

/** For toFilterOptionsRpcPayload — returns null when inactive. */
export function pushStatusRpcPayload(f: PushStatusFilter | undefined): object | null {
  return f ? { clientId: f.clientId, platform: f.platform, status: f.status } : null;
}
