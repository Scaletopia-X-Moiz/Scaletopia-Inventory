export function parseCSV(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const records: string[][] = [];
  let current: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i += 2;
      } else if (ch === '"') {
        inQuotes = false;
        i++;
      } else {
        field += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
        i++;
      } else if (ch === ',') {
        current.push(field);
        field = "";
        i++;
      } else if (ch === '\r' && text[i + 1] === '\n') {
        current.push(field);
        field = "";
        records.push(current);
        current = [];
        i += 2;
      } else if (ch === '\n') {
        current.push(field);
        field = "";
        records.push(current);
        current = [];
        i++;
      } else {
        field += ch;
        i++;
      }
    }
  }

  current.push(field);
  records.push(current);

  const nonEmpty = records.filter((r) => r.some((f) => f.trim() !== ""));
  if (nonEmpty.length === 0) return { headers: [], rows: [] };

  const headers = nonEmpty[0];
  const rows: Record<string, string>[] = [];

  for (let li = 1; li < nonEmpty.length; li++) {
    const values = nonEmpty[li];
    if (values.every((v) => v === "")) continue;
    const row: Record<string, string> = {};
    for (let hi = 0; hi < headers.length; hi++) {
      row[headers[hi]] = values[hi] ?? "";
    }
    rows.push(row);
  }

  return { headers, rows };
}

// A mapped record is only worth keeping if at least one of its target's
// identity fields ends up populated. This is the single source of truth for
// "is this row effectively empty" — reused both server-side (to decide what
// actually gets inserted/updated) and client-side (to avoid uploading rows
// that would be discarded anyway).
//
// BUG D: the check must be target-aware. A company can legitimately be
// identified by domain / linkedin_url / company_name. A PERSON, however,
// requires an actual personal identity — `company_name` alone is NOT enough,
// otherwise a people import of a row carrying only an employer name (no
// full_name/first_name/linkedin_url/email) would be inserted as a nameless
// person. So people use their own set that deliberately excludes company_name.
export const IDENTITY_FIELDS = ["domain", "linkedin_url", "company_name", "full_name", "first_name"] as const;
export const PERSON_IDENTITY_FIELDS = ["full_name", "first_name", "linkedin_url", "email"] as const;

// Postgres array columns — incoming CSV values are comma-separated strings and
// must be split into string arrays before insert/update.
const ARRAY_FIELDS = new Set(["technologies", "keywords"]);

// Postgres integer columns. Incoming CSV values are strings, and the DB rejects
// the ENTIRE row (22P02) if any of these carries a non-integer — e.g. a range
// like "10-50", a formatted "1,200", or misaligned text like "LLC". We coerce
// to a clean integer string here (matching the update RPC's `^[0-9]+$` guard in
// migrations.sql) and drop anything that can't be one, so a single bad cell
// nulls that field instead of failing the whole record.
const INTEGER_FIELDS = new Set(["employee_count", "founded_year"]);

// Coerce a raw CSV value to a plain integer string, or null if it isn't one.
// Strips thousands separators and surrounding whitespace first so "1,200" and
// " 42 " survive, but ranges ("10-50") and junk ("LLC") become null.
function coerceInteger(val: string): string | null {
  const cleaned = val.replace(/[,\s]/g, "");
  return /^\d+$/.test(cleaned) ? cleaned : null;
}

function mapRow(
  row: Record<string, string>,
  columnMap: Record<string, string>
): Record<string, unknown> {
  const out: Record<string, unknown> = {};

  // Guard against many-to-one column maps corrupting a scalar field. Auto
  // mapping (and stale saved presets) can map several headers onto the same
  // target — e.g. Store Leads' `domain`, `platform_domain`, `cluster_domains`
  // and `domain_count` all landing on `domain`. Plain object-order iteration is
  // last-non-empty-wins, so a junk column silently overwrites the real domain
  // (the identity key) and the row fails or duplicates on insert. Two defenses:
  //   1. Process headers whose name exactly equals the target field FIRST, so
  //      the canonical column (`domain` -> `domain`) always wins.
  //   2. For scalar fields, never overwrite a value already set (first-non-empty
  //      wins). Array / custom_data fields still accumulate as before.
  const entries = Object.entries(columnMap).sort(([ha, fa], [hb, fb]) => {
    const exactA = ha === fa ? 0 : 1;
    const exactB = hb === fb ? 0 : 1;
    return exactA - exactB;
  });

  for (const [csvHeader, supabaseField] of entries) {
    if (supabaseField === "ignore" || !supabaseField) continue;
    const val = row[csvHeader];
    if (val === undefined || val === "") continue;

    if (supabaseField === "custom_data") {
      const existing = out.custom_data as Record<string, string> | undefined;
      out.custom_data = { ...existing, [csvHeader]: val };
    } else if (ARRAY_FIELDS.has(supabaseField)) {
      if (out[supabaseField] !== undefined) continue;
      out[supabaseField] = val
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s !== "");
    } else if (supabaseField === "email") {
      if (out[supabaseField] !== undefined) continue;
      // A single company `email` column stores every address for the
      // company. Some providers (e.g. Store Leads) pack multiple
      // addresses into one cell separated by colons/semicolons; normalize
      // any such list to a clean comma-separated string. A normal single
      // email has no separators and passes through unchanged.
      out[supabaseField] = val
        .split(/[:;,]+/)
        .map((s) => s.trim())
        .filter(Boolean)
        .join(", ");
    } else if (INTEGER_FIELDS.has(supabaseField)) {
      if (out[supabaseField] !== undefined) continue;
      const coerced = coerceInteger(val);
      if (coerced !== null) out[supabaseField] = coerced;
    } else {
      if (out[supabaseField] !== undefined) continue;
      out[supabaseField] = val;
    }
  }
  return out;
}

// `targetTable` defaults to "companies" so existing company-oriented callers
// (and tests) keep their behavior; people imports must pass "people" to get the
// stricter person-identity check.
function isMappedRecordNonEmpty(
  record: Record<string, unknown>,
  targetTable: "companies" | "people" = "companies"
): boolean {
  const fields = targetTable === "people" ? PERSON_IDENTITY_FIELDS : IDENTITY_FIELDS;
  return fields.some((f) => record[f] != null && record[f] !== "");
}

export function applyColumnMap(
  rows: Record<string, string>[],
  columnMap: Record<string, string>,
  targetTable: "companies" | "people" = "companies"
): Record<string, unknown>[] {
  return rows
    .map((row) => mapRow(row, columnMap))
    .filter((rec) => isMappedRecordNonEmpty(rec, targetTable));
}

/**
 * Filters raw CSV rows (pre-mapping) down to only those that would survive
 * `applyColumnMap` — i.e. rows that have at least one populated identity
 * field once the column mapping is applied. Used client-side to strip
 * effectively-empty rows before upload, since the server discards them
 * anyway (see `applyColumnMap`/`pushRecords`).
 */
export function filterMappedNonEmptyRows(
  rows: Record<string, string>[],
  columnMap: Record<string, string>,
  targetTable: "companies" | "people" = "companies"
): Record<string, string>[] {
  return rows.filter((row) =>
    isMappedRecordNonEmpty(mapRow(row, columnMap), targetTable)
  );
}

function csvField(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * Serializes headers + row objects back into CSV text (inverse of
 * `parseCSV`). Used to rebuild `allText` from a filtered subset of rows.
 */
export function serializeCSV(
  headers: string[],
  rows: Record<string, string>[]
): string {
  const lines = [headers.map(csvField).join(",")];
  for (const row of rows) {
    lines.push(headers.map((h) => csvField(row[h] ?? "")).join(","));
  }
  return lines.join("\n");
}
