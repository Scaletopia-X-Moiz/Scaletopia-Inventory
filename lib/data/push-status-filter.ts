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
  if (!clientId || !platform || !status) return undefined;
  return { clientId, platform, status };
}

/** For toFilterOptionsRpcPayload — returns null when inactive. */
export function pushStatusRpcPayload(f: PushStatusFilter | undefined): object | null {
  return f ? { clientId: f.clientId, platform: f.platform, status: f.status } : null;
}
