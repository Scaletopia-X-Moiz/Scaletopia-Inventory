import type { NextRequest } from "next/server";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";
import { getPeopleForEmailBison, getPeopleForEmailBisonByCompanyFilters } from "@/lib/data/people";
import { resolveDefaultFieldMapping } from "@/lib/push/resolve-default-field-mapping";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

type Entity = "people" | "companies";

function isEntity(value: unknown): value is Entity {
  return value === "people" || value === "companies";
}

/** Resolves the standard-field mapping table's pre-populated default
 * (resolveDefaultFieldMapping, ticket #108) against the exact candidate set
 * the push itself would use — same loaders as the push route
 * (app/api/emailbison/push), just read-only. Companies-table filters resolve
 * to every linked Person (ADR 0003), same as the actual push. */
export async function GET(request: NextRequest) {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const entity = request.nextUrl.searchParams.get("entity");
  if (!isEntity(entity)) {
    return Response.json({ error: 'entity must be "people" or "companies"' }, { status: 400 });
  }

  const candidates =
    entity === "people"
      ? await getPeopleForEmailBison(parsePersonFilters(request.nextUrl.searchParams))
      : await getPeopleForEmailBisonByCompanyFilters(parseCompanyFilters(request.nextUrl.searchParams));

  const { standardFields } = resolveDefaultFieldMapping({
    platform: "emailbison",
    records: candidates.map((c) => c.record),
  });

  return Response.json({ standardFields });
}
