/** Shared CSV helpers for the export routes. Exports carry the *full* record —
 * every native column plus each row's enrichment (`custom_data`) keys — so the
 * header set isn't fixed: it's the ordered union of a known set of columns and
 * whatever enrichment keys appear across the exported rows. */

export function csvCell(value: string): string {
  if (/[",\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/** Flattens a single enrichment value to a CSV cell: arrays are comma-joined,
 * objects are JSON-encoded, everything else is stringified. Null/undefined
 * become empty. */
export function stringifyCsvValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map((v) => stringifyCsvValue(v)).join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/** Builds a CSV where `fixedHeaders` always lead (in the given order) and any
 * extra keys present on the records are appended as columns in first-seen
 * order — that's how per-row enrichment keys become their own columns without
 * every row having to share the same set. */
export function buildCsv(
  fixedHeaders: string[],
  records: Array<Record<string, string>>
): string {
  const extraHeaders: string[] = [];
  const seen = new Set(fixedHeaders);
  for (const record of records) {
    for (const key of Object.keys(record)) {
      if (!seen.has(key)) {
        seen.add(key);
        extraHeaders.push(key);
      }
    }
  }

  const headers = [...fixedHeaders, ...extraHeaders];
  const lines = [headers.map(csvCell).join(",")];
  for (const record of records) {
    lines.push(headers.map((h) => csvCell(record[h] ?? "")).join(","));
  }
  return lines.join("\n");
}
