import type { NextRequest } from "next/server";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { getPeopleForGhl } from "@/lib/data/people";
import { getClientById } from "@/lib/data/clients";
import { getGhlCustomFields } from "@/lib/ghl/custom-fields";
import { GhlApiError } from "@/lib/ghl/client";
import { resolveDefaultFieldMapping } from "@/lib/push/resolve-default-field-mapping";
import { isValidActiveVirtualColumn, type ActiveVirtualColumn } from "@/lib/data/virtual-columns";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

function parseVirtualColumns(value: unknown): ActiveVirtualColumn[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isValidActiveVirtualColumn);
}

/** Computes the unified mapping table's pre-populated defaults (ticket #111):
 * the client's current GHL custom fields plus resolveDefaultFieldMapping's
 * (ticket #108) auto-mapping over them and the current filtered People view
 * — the company-name default needs to see the actual pushed records
 * (brand_name coverage), which only this server side has. */
export async function POST(request: NextRequest) {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const filters = parsePersonFilters(request.nextUrl.searchParams);

  let clientId: unknown;
  let virtualColumnsRaw: unknown;
  try {
    ({ clientId, virtualColumns: virtualColumnsRaw } = await request.json());
  } catch {
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  if (typeof clientId !== "string" || clientId.trim() === "") {
    return Response.json({ error: "A clientId is required" }, { status: 400 });
  }

  const client = await getClientById(clientId);
  if (!client || !client.ghlApiKey || !client.ghlLocationId) {
    return Response.json({ error: "Client has no GHL credentials configured" }, { status: 404 });
  }

  const virtualColumns = parseVirtualColumns(virtualColumnsRaw);

  try {
    const [customFields, candidates] = await Promise.all([
      getGhlCustomFields({ id: client.id, apiKey: client.ghlApiKey, locationId: client.ghlLocationId }),
      getPeopleForGhl(filters),
    ]);

    const defaults = resolveDefaultFieldMapping({
      platform: "ghl",
      records: candidates.map((c) => c.record),
      virtualColumns,
      customFields,
    });

    return Response.json({
      customFields,
      standardFields: defaults.standardFields,
      customFieldMapping: defaults.customFieldMapping,
    });
  } catch (err) {
    const message = err instanceof GhlApiError || err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 502 });
  }
}
