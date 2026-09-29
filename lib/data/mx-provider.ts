// ESP (email service provider) of a lead, read from `companies.mx_provider`
// (ticket #25). The column is written by the domain MX lookup and holds a
// small fixed vocabulary: google, microsoft, other, none (no mail server
// found), plus the odd `unknown`. People have no ESP column of their own:
// a person's ESP is their linked company's value.
//
// Client-safe on purpose (no server-only import): the filter slips and the
// tables import the labels.
import type { IncludeExclude } from "@/lib/data/include-exclude";

export const MX_PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  microsoft: "Microsoft (Outlook)",
  other: "Other ESP",
  none: "No mail server",
  unknown: "Unknown",
};

/** Human label for a raw mx_provider value. Unmapped values fall back to the
 * raw value so a new provider slug still renders (and filters) instead of
 * disappearing. */
export function mxProviderLabel(id: string | null | undefined): string {
  if (!id) return "";
  return MX_PROVIDER_LABELS[id] ?? id;
}

/** URL param for the filter: `esp` / `esp_exclude`, parsed with the shared
 * include/exclude helper like every other facet. */
export const MX_PROVIDER_PARAM = "esp";

/** ESP values are short slugs. Anything else in the URL is dropped before it
 * reaches a PostgREST filter string, where a comma or bracket would change
 * the meaning of the clause. */
const SAFE_VALUE = /^[a-z0-9_-]+$/i;

export function sanitizeMxProviderFilter(filter: IncludeExclude | undefined): IncludeExclude | undefined {
  if (!filter) return undefined;
  return {
    include: filter.include.filter((v) => SAFE_VALUE.test(v)),
    exclude: filter.exclude.filter((v) => SAFE_VALUE.test(v)),
  };
}

export function isMxProviderFilterActive(filter: IncludeExclude | undefined): boolean {
  return !!filter && (filter.include.length > 0 || filter.exclude.length > 0);
}

/** PostgREST `or` clause for "not any of these ESPs". Unlike the plain
 * `.notIn()` used by the other scalar filters, it keeps rows whose ESP is
 * NULL, so the PostgREST path returns the same rows as the SQL RPCs
 * (`mx_provider IS NULL OR NOT (mx_provider = ANY(...))`). Otherwise a
 * Companies list could change size just because a push-status filter was
 * added and the query moved to the RPC path. */
export function mxProviderExcludeOrClause(column: string, exclude: string[]): string {
  return `${column}.is.null,${column}.not.in.(${exclude.join(",")})`;
}
