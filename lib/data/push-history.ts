import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

export interface PushHistoryFilters {
  clientId?: string;
  platform?: string;
}

export interface PushHistoryRow {
  id: string;
  person: { id: string; name: string | null } | null;
  client: { id: string; name: string | null } | null;
  platform: string;
  campaignTag: string | null;
  platformContactId: string | null;
  pushedByUserId: string | null;
  pushedByEmail: string | null;
  pushedAt: string;
}

export interface PushHistoryResult {
  rows: PushHistoryRow[];
  total: number;
}

const PUSH_HISTORY_COLUMNS =
  "id,platform,campaign_tag,platform_contact_id,pushed_by_user_id,pushed_by_email,pushed_at,person:people(id,full_name),client:clients(id,name)";

interface RawPushHistoryRow {
  id: string;
  platform: string;
  campaign_tag: string | null;
  platform_contact_id: string | null;
  pushed_by_user_id: string | null;
  pushed_by_email: string | null;
  pushed_at: string;
  person: { id: string; full_name: string | null } | null;
  client: { id: string; name: string | null } | null;
}

function toPushHistoryRow(raw: RawPushHistoryRow): PushHistoryRow {
  return {
    id: raw.id,
    person: raw.person ? { id: raw.person.id, name: raw.person.full_name } : null,
    client: raw.client ? { id: raw.client.id, name: raw.client.name } : null,
    platform: raw.platform,
    campaignTag: raw.campaign_tag,
    platformContactId: raw.platform_contact_id,
    pushedByUserId: raw.pushed_by_user_id,
    pushedByEmail: raw.pushed_by_email,
    pushedAt: raw.pushed_at,
  };
}

/** Paginated `platform_pushes` history, newest first, joined to the person
 * and client each row references. Offset-based (rather than page-based, per
 * companies/dashboard) since this backs both a server-rendered first page
 * and a "load more" API route sharing the same offset cursor. No UI here —
 * see ticket #68. */
export async function listPushHistory(
  filters: PushHistoryFilters = {},
  limit = 50,
  offset = 0
): Promise<PushHistoryResult> {
  let query = supabaseAdmin.from("platform_pushes").select(PUSH_HISTORY_COLUMNS, { count: "exact" });

  if (filters.clientId) query = query.eq("client_id", filters.clientId);
  if (filters.platform) query = query.eq("platform", filters.platform);

  query = query.order("pushed_at", { ascending: false }).order("id", { ascending: true });

  const { data, error, count } = await query.range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = (data ?? []) as unknown as RawPushHistoryRow[];
  return { rows: rows.map(toPushHistoryRow), total: count ?? 0 };
}
