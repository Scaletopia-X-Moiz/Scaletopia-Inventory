import "server-only";

/**
 * Client names for the import wizard's Client dropdown.
 *
 * The source of truth for "who is a real, current client" is the Operations &
 * Data Analytics base, table "Clients", field "Client Status" (the same table
 * the attainment dashboard reads). It is NOT the databank `clients` table,
 * which is the push-credential list: it holds a row per GHL / EmailBison
 * account, including Secondary accounts, test accounts and churned clients.
 */
export const OPS_BASE_ID = "appP3VJXaEqNopR1l";
export const OPS_CLIENTS_TABLE_ID = "tblX0E8Nek2xGeWxY";
const CLIENT_NAME_FIELD_ID = "fldD54l4901ERPq05";
const CLIENT_STATUS_FIELD_ID = "fldE16jZwdsDifSMU";
const ACTIVE_STATUS = "Active";

interface AirtableListResponse {
  records?: { fields?: Record<string, unknown> }[];
  offset?: string;
}

/** Trimmed, de-duplicated (case-insensitive), alphabetical. Pure, for tests. */
export function toClientNames(records: { fields?: Record<string, unknown> }[]): string[] {
  const seen = new Map<string, string>();
  for (const r of records) {
    const raw = r.fields?.[CLIENT_NAME_FIELD_ID];
    const name = typeof raw === "string" ? raw.trim() : "";
    if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

export async function listImportClientNames(
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const records: { fields?: Record<string, unknown> }[] = [];
  let offset: string | undefined;
  do {
    const url = new URL(`https://api.airtable.com/v0/${OPS_BASE_ID}/${OPS_CLIENTS_TABLE_ID}`);
    url.searchParams.set("returnFieldsByFieldId", "true");
    url.searchParams.append("fields[]", CLIENT_NAME_FIELD_ID);
    url.searchParams.append("fields[]", CLIENT_STATUS_FIELD_ID);
    url.searchParams.set("filterByFormula", `{Client Status}="${ACTIVE_STATUS}"`);
    if (offset) url.searchParams.set("offset", offset);
    const res = await fetchImpl(url, {
      headers: { Authorization: `Bearer ${token}` },
      next: { revalidate: 300 },
    } as RequestInit);
    if (!res.ok) throw new Error(`Airtable Clients read failed (${res.status})`);
    const body = (await res.json()) as AirtableListResponse;
    records.push(...(body.records ?? []));
    offset = body.offset;
  } while (offset);
  return toClientNames(records);
}
