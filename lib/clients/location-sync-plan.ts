/**
 * Pure planning half of the Airtable -> `clients` sync.
 *
 * Why this exists: the `clients` table (the list behind "Push to GHL — choose a
 * client" and the EmailBison pickers) was seeded once from .env.local and then
 * only ever edited by hand on /clients, so every GHL sub-account or EmailBison
 * workspace added since never appeared. The ops source of truth is the
 * Airtable "Master Inbox & CRM" base, table `Locations`: one row per GHL
 * location (Platform = GoHighLevel) or EmailBison workspace (Platform =
 * EmailBison), linked to each other by "Bison <-> GHL Match".
 *
 * Airtable is not trusted blindly. Location ids there are recycled across
 * clients, and its "Location Status" lags reality (several "Active" rows point
 * at sub-accounts GHL itself now names "Inactive #N"). So the IO half
 * (location-sync.ts) asks GHL and EmailBison who each key really belongs to,
 * and this planner only acts on what both sides agree on:
 *
 *  - It only ever INSERTS new rows, or FILLS a credential that is empty. It
 *    never overwrites an existing value, re-points a location, renames, or
 *    deactivates a row: those change where real pushes land, so they are
 *    reported for a human instead.
 *  - A GHL location is inserted only when its own Airtable key can read it and
 *    GHL's name for it isn't a retired one ("Inactive #6", "Banned # 1", ...).
 *  - An EmailBison key is used only when EmailBison says it belongs to a
 *    workspace whose name matches the client (so a key that resolves to a
 *    placeholder workspace such as "API's Team" is never wired in).
 *  - A new row is never given the name of an existing row; that is reported as
 *    a conflict.
 *
 * No imports, so a plain Node script can load it as well as the app.
 */

export const DEFAULT_EMAILBISON_BASE_URL = "https://send.scaletopia.io";

/** GHL's own naming for sub-accounts that no longer belong to a live client. */
const RETIRED_LOCATION_NAME = /^\s*(inactive|banned|not working|rejected)\b/i;

export interface SyncDbClient {
  id: string;
  slug: string;
  name: string;
  ghlLocationId: string | null;
  hasGhlKey: boolean;
  hasEbKey: boolean;
  /** Workspace id EmailBison reports for this row's stored key, or null when
   * the row has no key or the key could not be verified. */
  ebWorkspaceId: number | null;
  isActive: boolean;
}

export interface GhlLocationCandidate {
  airtableRecordId: string;
  airtableName: string;
  status: string | null;
  locationId: string;
  apiKey: string;
  /** GHL's name for the location as read WITH THIS ROW'S KEY, or null when the
   * key could not read it (revoked, wrong location, missing scope). */
  liveName: string | null;
  /** Airtable record id of the linked EmailBison row, if any. */
  bisonRecordId: string | null;
}

export interface BisonWorkspaceCandidate {
  airtableRecordId: string;
  airtableName: string;
  status: string | null;
  apiKey: string;
  /** What EmailBison says this key belongs to, or null when it could not be
   * verified. */
  workspace: { id: number; name: string } | null;
}

export interface SyncInputs {
  clients: SyncDbClient[];
  ghl: GhlLocationCandidate[];
  bison: BisonWorkspaceCandidate[];
  /** GHL's name per location id, from any key that could read it (Airtable's
   * or the databank's own). Used only to report stale rows. */
  liveNameByLocation: Record<string, string | null>;
  emailbisonBaseUrl?: string;
}

export interface PlannedInsert {
  slug: string;
  name: string;
  ghlLocationId: string | null;
  ghlApiKey: string | null;
  emailbisonApiKey: string | null;
  emailbisonBaseUrl: string | null;
  source: string;
}

export interface PlannedFill {
  clientId: string;
  clientName: string;
  ghlApiKey?: string;
  emailbisonApiKey?: string;
  emailbisonBaseUrl?: string;
  source: string;
}

export type SyncNoteKind = "conflict" | "stale" | "skipped";

export interface SyncNote {
  kind: SyncNoteKind;
  name: string;
  detail: string;
}

export interface SyncPlan {
  inserts: PlannedInsert[];
  fills: PlannedFill[];
  notes: SyncNote[];
  /** Names of existing rows already matched to a live Airtable row. */
  linked: string[];
}

/** Rows left behind by test suites (`test_clients_ts_*`, `__test-*`). They are
 * never matched, renamed against, or reported on. */
export function isTestClient(c: Pick<SyncDbClient, "slug">): boolean {
  return /^(test_|__test)/.test(c.slug);
}

export function isRetiredLocationName(name: string | null | undefined): boolean {
  return name != null && RETIRED_LOCATION_NAME.test(name);
}

/** "Go fish Digital - Active" -> "Go fish Digital". GHL suffixes live
 * sub-accounts with their status. */
export function stripStatusSuffix(name: string): string {
  return name.replace(/\s*-\s*active\s*$/i, "").trim();
}

function norm(name: string): string {
  return stripStatusSuffix(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Same client, allowing qualifiers on either side: "Scaletopia" matches
 * "Scaletopia (A2P verified)", "Big Leap" matches "Bigleap", "Chamber Media"
 * matches "Chamber Media Secondary". */
export function namesCompatible(a: string, b: string): boolean {
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.startsWith(nb) || nb.startsWith(na);
}

export function slugify(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function isActiveStatus(status: string | null): boolean {
  return (status ?? "").trim().toLowerCase() === "active";
}

export function planClientSync(inputs: SyncInputs): SyncPlan {
  const baseUrl = inputs.emailbisonBaseUrl ?? DEFAULT_EMAILBISON_BASE_URL;
  const realClients = inputs.clients.filter((c) => !isTestClient(c));
  const takenSlugs = new Set(inputs.clients.map((c) => c.slug));
  const takenNames = new Set(realClients.map((c) => norm(c.name)));
  const heldWorkspaces = new Set(
    realClients.map((c) => c.ebWorkspaceId).filter((id): id is number => id != null)
  );
  const bisonById = new Map(inputs.bison.map((b) => [b.airtableRecordId, b]));

  const plan: SyncPlan = { inserts: [], fills: [], notes: [], linked: [] };

  function uniqueSlug(name: string): string {
    const base = slugify(name) || "client";
    let slug = base;
    for (let n = 2; takenSlugs.has(slug); n++) slug = `${base}_${n}`;
    takenSlugs.add(slug);
    return slug;
  }

  /** The EmailBison key to wire to `clientName`, if the linked Airtable row's
   * key verifiably belongs to a workspace of that client. */
  function verifiedBisonFor(bisonRecordId: string | null, clientName: string): BisonWorkspaceCandidate | null {
    if (!bisonRecordId) return null;
    const bison = bisonById.get(bisonRecordId);
    if (!bison?.workspace) return null;
    return namesCompatible(bison.workspace.name, clientName) ? bison : null;
  }

  const activeGhl = inputs.ghl.filter((g) => isActiveStatus(g.status) && g.locationId && g.apiKey);
  const airtableNameCounts = new Map<string, number>();
  for (const g of activeGhl) airtableNameCounts.set(norm(g.airtableName), (airtableNameCounts.get(norm(g.airtableName)) ?? 0) + 1);

  // 1. GHL locations ---------------------------------------------------------
  for (const g of activeGhl) {
    const linked = realClients.find(
      (c) =>
        c.ghlLocationId === g.locationId &&
        (namesCompatible(c.name, g.airtableName) || (g.liveName != null && namesCompatible(c.name, g.liveName)))
    );

    if (linked) {
      plan.linked.push(linked.name);
      const fill: PlannedFill = { clientId: linked.id, clientName: linked.name, source: `Airtable ${g.airtableRecordId}` };
      if (!linked.hasGhlKey && g.liveName != null && !isRetiredLocationName(g.liveName)) fill.ghlApiKey = g.apiKey;
      const bison = linked.hasEbKey ? null : verifiedBisonFor(g.bisonRecordId, linked.name);
      if (bison && bison.workspace) {
        fill.emailbisonApiKey = bison.apiKey;
        fill.emailbisonBaseUrl = baseUrl;
        heldWorkspaces.add(bison.workspace.id);
      }
      if (fill.ghlApiKey || fill.emailbisonApiKey) plan.fills.push(fill);
      continue;
    }

    if (g.liveName == null) {
      plan.notes.push({
        kind: "skipped",
        name: g.airtableName,
        detail: `Airtable's API key cannot read GHL location ${g.locationId} (revoked or wrong location), so it was not added.`,
      });
      continue;
    }
    if (isRetiredLocationName(g.liveName)) {
      plan.notes.push({
        kind: "skipped",
        name: g.airtableName,
        detail: `Airtable marks it Active, but GHL calls location ${g.locationId} "${g.liveName.trim()}", so it was not added.`,
      });
      continue;
    }

    const name =
      (airtableNameCounts.get(norm(g.airtableName)) ?? 0) > 1 ? stripStatusSuffix(g.liveName) : g.airtableName.trim();
    if (takenNames.has(norm(name))) {
      const holder = realClients.find((c) => norm(c.name) === norm(name));
      plan.notes.push({
        kind: "conflict",
        name,
        detail: `GHL location ${g.locationId} ("${stripStatusSuffix(g.liveName)}") is live, but the existing "${holder?.name ?? name}" row points at ${holder?.ghlLocationId ?? "no location"}. Fix that row by hand on /clients.`,
      });
      continue;
    }

    const bison = verifiedBisonFor(g.bisonRecordId, name);
    if (bison?.workspace) heldWorkspaces.add(bison.workspace.id);
    takenNames.add(norm(name));
    plan.inserts.push({
      slug: uniqueSlug(name),
      name,
      ghlLocationId: g.locationId,
      ghlApiKey: g.apiKey,
      emailbisonApiKey: bison?.apiKey ?? null,
      emailbisonBaseUrl: bison ? baseUrl : null,
      source: `Airtable ${g.airtableRecordId}${bison ? ` + ${bison.airtableRecordId}` : ""}`,
    });
  }

  // 2. EmailBison workspaces with no databank row at all ---------------------
  for (const b of inputs.bison) {
    if (!isActiveStatus(b.status) || !b.apiKey || !b.workspace) continue;
    if (!namesCompatible(b.workspace.name, b.airtableName)) continue; // placeholder / mismatched key
    if (heldWorkspaces.has(b.workspace.id)) continue;
    const name = b.airtableName.trim();
    if (takenNames.has(norm(name))) {
      plan.notes.push({
        kind: "conflict",
        name,
        detail: `EmailBison workspace ${b.workspace.id} ("${b.workspace.name}") is not on any client row, but a row named "${name}" already exists with a different EmailBison key. Fix that row by hand on /clients.`,
      });
      continue;
    }
    heldWorkspaces.add(b.workspace.id);
    takenNames.add(norm(name));
    plan.inserts.push({
      slug: uniqueSlug(name),
      name,
      ghlLocationId: null,
      ghlApiKey: null,
      emailbisonApiKey: b.apiKey,
      emailbisonBaseUrl: baseUrl,
      source: `Airtable ${b.airtableRecordId}`,
    });
  }

  // 3. Existing rows whose GHL location is no longer theirs -------------------
  for (const c of realClients) {
    if (!c.ghlLocationId || !c.isActive) continue;
    const liveName = inputs.liveNameByLocation[c.ghlLocationId];
    if (liveName == null) continue; // unknown: nothing to say
    if (isRetiredLocationName(liveName)) {
      plan.notes.push({
        kind: "stale",
        name: c.name,
        detail: `Points at GHL location ${c.ghlLocationId}, which GHL now calls "${liveName.trim()}". Pushes to this client land in a retired sub-account.`,
      });
    } else if (!namesCompatible(c.name, liveName)) {
      plan.notes.push({
        kind: "stale",
        name: c.name,
        detail: `Points at GHL location ${c.ghlLocationId}, which GHL now calls "${stripStatusSuffix(liveName)}".`,
      });
    }
  }

  return plan;
}
