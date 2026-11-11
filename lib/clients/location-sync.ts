/**
 * IO half of the Airtable -> `clients` sync (the rules live in
 * location-sync-plan.ts). Reads Airtable's `Locations` table, asks GHL and
 * EmailBison who each key really belongs to, reads the `clients` table, and
 * applies a plan.
 *
 * Takes its Supabase client and fetch as arguments rather than importing
 * lib/supabase/admin.ts, so the same code runs from the app (server action,
 * cron route) and from scripts/sync-clients-from-airtable.ts, where the
 * "server-only" marker would throw.
 *
 * Keys flow from Airtable into the database and nowhere else: nothing here
 * logs or returns a key except inside the plan handed straight to apply.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  DEFAULT_EMAILBISON_BASE_URL,
  planClientSync,
  type BisonWorkspaceCandidate,
  type GhlLocationCandidate,
  type SyncDbClient,
  type SyncInputs,
  type SyncPlan,
} from "./location-sync-plan";

/** Airtable "Master Inbox & CRM" base, table "Locations". */
export const LOCATIONS_BASE_ID = "appgezzL6Uqr0xgBa";
export const LOCATIONS_TABLE_ID = "tblaFVVSTzuVPMpsg";

const GHL_API = "https://services.leadconnectorhq.com";
const PROBE_TIMEOUT_MS = 15_000;

type FetchLike = typeof fetch;

interface AirtableLocationRecord {
  id: string;
  fields: Record<string, unknown>;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

async function fetchAirtableLocations(token: string, fetchImpl: FetchLike): Promise<AirtableLocationRecord[]> {
  const records: AirtableLocationRecord[] = [];
  let offset: string | undefined;
  do {
    const url = new URL(`https://api.airtable.com/v0/${LOCATIONS_BASE_ID}/${LOCATIONS_TABLE_ID}`);
    for (const field of ["ID", "Name", "API Key", "Platform", "Location Status", "Bison <-> GHL Match"]) {
      url.searchParams.append("fields[]", field);
    }
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Airtable Locations read failed: HTTP ${res.status}`);
    const json = (await res.json()) as { records: AirtableLocationRecord[]; offset?: string };
    records.push(...json.records);
    offset = json.offset;
  } while (offset);
  return records;
}

/** GHL's name for `locationId` as seen by `apiKey`, or null if it can't read it. */
async function probeGhlLocation(locationId: string, apiKey: string, fetchImpl: FetchLike): Promise<string | null> {
  try {
    const res = await fetchImpl(`${GHL_API}/locations/${encodeURIComponent(locationId)}`, {
      headers: { Authorization: `Bearer ${apiKey}`, Version: "2021-07-28", Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { location?: { id?: string; name?: string } };
    if (json.location?.id && json.location.id !== locationId) return null;
    return typeof json.location?.name === "string" ? json.location.name : null;
  } catch {
    return null;
  }
}

/** The EmailBison workspace `apiKey` belongs to, or null if it can't be read. */
async function probeBisonWorkspace(
  baseUrl: string,
  apiKey: string,
  fetchImpl: FetchLike
): Promise<{ id: number; name: string } | null> {
  try {
    const res = await fetchImpl(`${baseUrl.replace(/\/+$/, "")}/api/users`, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { data?: { workspace?: { id?: unknown; name?: unknown } } };
    const ws = json.data?.workspace;
    return typeof ws?.id === "number" && typeof ws.name === "string" ? { id: ws.id, name: ws.name } : null;
  } catch {
    return null;
  }
}

interface RawClient {
  id: string;
  slug: string;
  name: string;
  ghl_location_id: string | null;
  ghl_api_key: string | null;
  emailbison_api_key: string | null;
  emailbison_workspace_id: string | null;
  is_active: boolean;
}

export interface LoadSyncInputsOptions {
  supabase: SupabaseClient;
  airtableToken: string;
  fetchImpl?: FetchLike;
  emailbisonBaseUrl?: string;
}

export async function loadSyncInputs(opts: LoadSyncInputsOptions): Promise<SyncInputs> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const baseUrl = opts.emailbisonBaseUrl ?? DEFAULT_EMAILBISON_BASE_URL;

  const [records, clientsResult] = await Promise.all([
    fetchAirtableLocations(opts.airtableToken, fetchImpl),
    opts.supabase
      .from("clients")
      .select("id,slug,name,ghl_location_id,ghl_api_key,emailbison_api_key,emailbison_workspace_id,is_active"),
  ]);
  if (clientsResult.error) throw clientsResult.error;
  const rawClients = (clientsResult.data ?? []) as RawClient[];

  const ghlRecords = records.filter((r) => r.fields.Platform === "GoHighLevel");
  const bisonRecords = records.filter((r) => r.fields.Platform === "EmailBison");

  const ghl: GhlLocationCandidate[] = await Promise.all(
    ghlRecords
      .map((r) => ({ r, locationId: str(r.fields.ID), apiKey: str(r.fields["API Key"]) }))
      .filter((x): x is { r: AirtableLocationRecord; locationId: string; apiKey: string } => !!x.locationId && !!x.apiKey)
      .map(async ({ r, locationId, apiKey }) => {
        const match = r.fields["Bison <-> GHL Match"];
        return {
          airtableRecordId: r.id,
          airtableName: str(r.fields.Name) ?? r.id,
          status: str(r.fields["Location Status"]),
          locationId,
          apiKey,
          liveName: await probeGhlLocation(locationId, apiKey, fetchImpl),
          bisonRecordId: Array.isArray(match) && typeof match[0] === "string" ? match[0] : null,
        };
      })
  );

  const bison: BisonWorkspaceCandidate[] = await Promise.all(
    bisonRecords
      .map((r) => ({ r, apiKey: str(r.fields["API Key"]) }))
      .filter((x): x is { r: AirtableLocationRecord; apiKey: string } => !!x.apiKey)
      .map(async ({ r, apiKey }) => ({
        airtableRecordId: r.id,
        airtableName: str(r.fields.Name) ?? r.id,
        status: str(r.fields["Location Status"]),
        apiKey,
        workspace: await probeBisonWorkspace(baseUrl, apiKey, fetchImpl),
      }))
  );

  const liveNameByLocation: Record<string, string | null> = {};
  for (const g of ghl) if (g.liveName != null) liveNameByLocation[g.locationId] = g.liveName;

  const clients: SyncDbClient[] = await Promise.all(
    rawClients.map(async (c) => {
      if (c.ghl_location_id && c.ghl_api_key && liveNameByLocation[c.ghl_location_id] == null) {
        const name = await probeGhlLocation(c.ghl_location_id, c.ghl_api_key, fetchImpl);
        if (name != null) liveNameByLocation[c.ghl_location_id] = name;
      }
      const ws =
        c.emailbison_api_key != null
          ? await probeBisonWorkspace(c.emailbison_workspace_id || baseUrl, c.emailbison_api_key, fetchImpl)
          : null;
      return {
        id: c.id,
        slug: c.slug,
        name: c.name,
        ghlLocationId: c.ghl_location_id,
        hasGhlKey: !!c.ghl_api_key,
        hasEbKey: !!c.emailbison_api_key,
        ebWorkspaceId: ws?.id ?? null,
        isActive: c.is_active,
      };
    })
  );

  return { clients, ghl, bison, liveNameByLocation, emailbisonBaseUrl: baseUrl };
}

export interface SyncResult {
  inserted: { id: string; name: string }[];
  filled: { id: string; name: string; fields: string[] }[];
  notes: SyncPlan["notes"];
  linked: string[];
}

/** Applies a plan. Inserts rely on `clients.slug`'s UNIQUE constraint; fills
 * only write a column that is still NULL at write time, so a value someone
 * typed on /clients between plan and apply is never overwritten. */
export async function applySyncPlan(supabase: SupabaseClient, plan: SyncPlan): Promise<SyncResult> {
  const now = new Date().toISOString();
  const result: SyncResult = { inserted: [], filled: [], notes: plan.notes, linked: plan.linked };

  if (plan.inserts.length > 0) {
    const { data, error } = await supabase
      .from("clients")
      .insert(
        plan.inserts.map((i) => ({
          slug: i.slug,
          name: i.name,
          ghl_location_id: i.ghlLocationId,
          ghl_api_key: i.ghlApiKey,
          emailbison_api_key: i.emailbisonApiKey,
          emailbison_workspace_id: i.emailbisonBaseUrl,
          is_active: true,
          updated_at: now,
        }))
      )
      .select("id,name");
    if (error) throw error;
    result.inserted = (data ?? []) as { id: string; name: string }[];
  }

  for (const f of plan.fills) {
    const fields: string[] = [];
    if (f.ghlApiKey) {
      const { data, error } = await supabase
        .from("clients")
        .update({ ghl_api_key: f.ghlApiKey, updated_at: now })
        .eq("id", f.clientId)
        .is("ghl_api_key", null)
        .select("id");
      if (error) throw error;
      if (data?.length) fields.push("ghl_api_key");
    }
    if (f.emailbisonApiKey) {
      const { data, error } = await supabase
        .from("clients")
        .update({ emailbison_api_key: f.emailbisonApiKey, emailbison_workspace_id: f.emailbisonBaseUrl, updated_at: now })
        .eq("id", f.clientId)
        .is("emailbison_api_key", null)
        .is("emailbison_workspace_id", null)
        .select("id");
      if (error) throw error;
      if (data?.length) fields.push("emailbison_api_key", "emailbison_workspace_id");
    }
    if (fields.length) result.filled.push({ id: f.clientId, name: f.clientName, fields });
  }

  return result;
}

/** One-shot: load, plan, and (unless `dryRun`) apply. */
export async function syncClientsFromAirtable(
  opts: LoadSyncInputsOptions & { dryRun?: boolean }
): Promise<{ plan: SyncPlan; result: SyncResult | null }> {
  const plan = planClientSync(await loadSyncInputs(opts));
  if (opts.dryRun) return { plan, result: null };
  return { plan, result: await applySyncPlan(opts.supabase, plan) };
}
