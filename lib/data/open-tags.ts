import type { IncludeExclude } from "@/lib/data/include-exclude";

/** URL param for the open-tags filter: `tags` / `tags_exclude`, parsed with the
 * shared include/exclude helper like every other facet. */
export const OPEN_TAGS_PARAM = "tags";

/** Open tags are free-form (GHL-style), so a value can hold spaces, commas,
 * quotes and braces. Quote each element for a PostgREST/Postgres array
 * literal: wrap in double quotes and backslash-escape `\` and `"`. */
export function pgArrayLiteral(values: string[]): string {
  return `{${values.map((v) => `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`).join(",")}}`;
}

/** include = overlap (`&&`), exclude = no overlap, on an `open_tags text[]`
 * column — the same semantics the SQL RPCs use. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function applyOpenTagsFilter(query: any, filter: IncludeExclude | undefined, column = "open_tags"): any {
  if (!filter) return query;
  let q = query;
  if (filter.exclude.length) q = q.not(column, "ov", pgArrayLiteral(filter.exclude));
  if (filter.include.length) q = q.filter(column, "ov", pgArrayLiteral(filter.include));
  return q;
}
