import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

export interface ClientRow {
  id: string;
  slug: string;
  name: string;
  ghlApiKey: string | null;
  ghlLocationId: string | null;
  emailbisonApiKey: string | null;
  emailbisonWorkspaceId: string | null;
  isActive: boolean;
  updatedAt: string;
}

interface RawClientRow {
  id: string;
  slug: string;
  name: string;
  ghl_api_key: string | null;
  ghl_location_id: string | null;
  emailbison_api_key: string | null;
  emailbison_workspace_id: string | null;
  is_active: boolean;
  updated_at: string;
}

const CLIENT_COLUMNS =
  "id,slug,name,ghl_api_key,ghl_location_id,emailbison_api_key,emailbison_workspace_id,is_active,updated_at";

function toClientRow(raw: RawClientRow): ClientRow {
  return {
    id: raw.id,
    slug: raw.slug,
    name: raw.name,
    ghlApiKey: raw.ghl_api_key,
    ghlLocationId: raw.ghl_location_id,
    emailbisonApiKey: raw.emailbison_api_key,
    emailbisonWorkspaceId: raw.emailbison_workspace_id,
    isActive: raw.is_active,
    updatedAt: raw.updated_at,
  };
}

/** Lists every client with is_active = true, ordered by name. */
export async function listActiveClients(): Promise<ClientRow[]> {
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select(CLIENT_COLUMNS)
    .eq("is_active", true)
    .order("name", { ascending: true });

  if (error) throw error;
  return ((data ?? []) as unknown as RawClientRow[]).map(toClientRow);
}

/** Lists every client regardless of active status, ordered by name. */
export async function listClients(): Promise<ClientRow[]> {
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select(CLIENT_COLUMNS)
    .order("name", { ascending: true });

  if (error) throw error;
  return ((data ?? []) as unknown as RawClientRow[]).map(toClientRow);
}

export interface ClientOption {
  id: string;
  name: string;
}

/** Lists every client as a minimal {id, name} pair, ordered by name. For UI
 * pickers (e.g. the push-history filter) that don't need credentials. */
export async function listClientOptions(): Promise<ClientOption[]> {
  const { data, error } = await supabaseAdmin.from("clients").select("id,name").order("name", { ascending: true });

  if (error) throw error;
  return (data ?? []) as ClientOption[];
}

/** Fetches a single client by id. Returns null if it doesn't exist. */
export async function getClientById(id: string): Promise<ClientRow | null> {
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select(CLIENT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return toClientRow(data as unknown as RawClientRow);
}

export interface UpdateClientCredentialsInput {
  ghlApiKey?: string | null;
  ghlLocationId?: string | null;
  emailbisonApiKey?: string | null;
  emailbisonWorkspaceId?: string | null;
  isActive?: boolean;
}

/** Updates a client's push credentials. Only the fields present in `input`
 * are touched; omit a field to leave its current value alone. */
export async function updateClientCredentials(
  id: string,
  input: UpdateClientCredentialsInput
): Promise<ClientRow> {
  const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
  if ("ghlApiKey" in input) patch.ghl_api_key = input.ghlApiKey;
  if ("ghlLocationId" in input) patch.ghl_location_id = input.ghlLocationId;
  if ("emailbisonApiKey" in input) patch.emailbison_api_key = input.emailbisonApiKey;
  if ("emailbisonWorkspaceId" in input) patch.emailbison_workspace_id = input.emailbisonWorkspaceId;
  if ("isActive" in input) patch.is_active = input.isActive;

  const { data, error } = await supabaseAdmin
    .from("clients")
    .update(patch)
    .eq("id", id)
    .select(CLIENT_COLUMNS)
    .single();

  if (error) throw error;
  return toClientRow(data as unknown as RawClientRow);
}
