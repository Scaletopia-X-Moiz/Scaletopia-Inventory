import type { NextRequest } from "next/server";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";
import {
  getEmailBisonCompanyNameFields,
  getEmailBisonCompanyNameFieldsByCompanyFilters,
} from "@/lib/data/people";
import { resolveDefaultFieldMapping } from "@/lib/push/resolve-default-field-mapping";
import { getUser } from "@/lib/auth/dal";

export const dynamic = "force-dynamic";

type Entity = "people" | "companies";

function isEntity(value: unknown): value is Entity {
  return value === "people" || value === "companies";
}

/** Resolves the standard-field mapping table's pre-populated default
 * (resolveDefaultFieldMapping, ticket #108) against the same candidate set the
 * push itself would use — resolved through the same filters, but selecting only
 * the two company-name columns the resolver reads instead of the full `*` row
 * (perf: avoids scanning every column of the entire filtered set). Companies-
 * table filters resolve to every linked Person (ADR 0003), same as the actual
 * push. */
export async function GET(request: NextRequest) {
  const user = await getUser();
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const entity = request.nextUrl.searchParams.get("entity");
  if (!isEntity(entity)) {
    return Response.json({ error: 'entity must be "people" or "companies"' }, { status: 400 });
  }

  const records =
    entity === "people"
      ? await getEmailBisonCompanyNameFields(parsePersonFilters(request.nextUrl.searchParams))
      : await getEmailBisonCompanyNameFieldsByCompanyFilters(
          parseCompanyFilters(request.nextUrl.searchParams)
        );

  const { standardFields } = resolveDefaultFieldMapping({
    platform: "emailbison",
    records,
  });

  return Response.json({ standardFields });
}
