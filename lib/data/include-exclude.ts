export interface IncludeExclude {
  include: string[];
  exclude: string[];
}

export function includeOnly(ids: string[]): IncludeExclude {
  return { include: ids, exclude: [] };
}

/** Reads an include/exclude param pair — e.g. `industry` / `industry_exclude`
 * — off a URLSearchParams instance. */
export function parseIncludeExcludeParam(searchParams: URLSearchParams, param: string): IncludeExclude {
  return {
    include: searchParams.getAll(param),
    exclude: searchParams.getAll(`${param}_exclude`),
  };
}

/** Generalized facet matcher: `ids` is every candidate id a row produces for
 * this facet (a single-element array for facets like industry/country, or
 * multiple tokens for facets like source, which derive several tokens per
 * row). Excluded ids always lose; when there's an include list, at least one
 * id must be in it. */
export function matchesIncludeExclude(ids: string[], filter: IncludeExclude | undefined): boolean {
  if (!filter) return true;
  if (filter.exclude.length && ids.some((id) => filter.exclude.includes(id))) return false;
  if (filter.include.length) return ids.some((id) => filter.include.includes(id));
  return true;
}
