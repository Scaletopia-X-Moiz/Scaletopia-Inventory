import type { GhlFieldMapping } from "@/lib/ghl/types";

/** Pre-#142 wire/persisted shape: column-only, no literal support. Still
 * shows up in an in-flight push_jobs.options.fieldMapping row queued before
 * the deploy, or a push_field_mappings row saved before the deploy. */
interface LegacyGhlFieldMappingEntry {
  virtualColumnKey: string;
  ghlFieldId: string;
}

function isLegacyEntry(value: unknown): value is LegacyGhlFieldMappingEntry {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m.virtualColumnKey === "string" && typeof m.ghlFieldId === "string";
}

function isCurrentEntry(value: unknown): value is GhlFieldMapping {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  if (typeof m.ghlFieldId !== "string") return false;
  if (m.source === "literal") return typeof m.value === "string";
  if (m.source === "column") return typeof m.columnKey === "string";
  return false;
}

/** Upgrades one array entry (wire body, worker's stored push_jobs.options, or
 * a legacy push_field_mappings row already coerced to an array) from either
 * shape to the current discriminated union. Anything else — malformed,
 * missing required fields — is dropped, matching how virtual-column filters
 * degrade elsewhere in this app rather than erroring the whole push over one
 * bad entry. */
function normalizeEntry(value: unknown): GhlFieldMapping | null {
  if (isCurrentEntry(value)) return value;
  if (isLegacyEntry(value)) {
    return { ghlFieldId: value.ghlFieldId, source: "column", columnKey: value.virtualColumnKey };
  }
  return null;
}

/** Central upgrade path for the array-shaped field mapping (ticket #142) —
 * routes every read (wire body in the push route, push_jobs.options in the
 * worker) through here so a legacy entry is upgraded rather than silently
 * dropped (which would look like a successful push that sends zero custom
 * fields). */
export function normalizeGhlFieldMapping(value: unknown): GhlFieldMapping[] {
  if (!Array.isArray(value)) return [];
  const normalized: GhlFieldMapping[] = [];
  for (const entry of value) {
    const upgraded = normalizeEntry(entry);
    if (upgraded) normalized.push(upgraded);
  }
  return normalized;
}

export interface SavedGhlCustomFieldMappingEntry {
  source: "column" | "literal";
  columnKey?: string;
  value?: string;
}

/** Upgrades the persisted `SavedGhlFieldMapping.customFieldMapping` Record
 * (push_field_mappings, platform "ghl") — legacy rows store a plain
 * virtualColumnKey string per ghlFieldId; current rows store the full
 * {source, columnKey?, value?} entry. A non-object/garbage value is dropped
 * (treated as "ignore this field") rather than spread raw into React state,
 * which would break the mapping table's controlled <select>s. */
export function normalizeSavedGhlCustomFieldMapping(
  value: unknown
): Record<string, SavedGhlCustomFieldMappingEntry> {
  if (typeof value !== "object" || value === null) return {};
  const result: Record<string, SavedGhlCustomFieldMappingEntry> = {};
  for (const [ghlFieldId, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") {
      result[ghlFieldId] = { source: "column", columnKey: entry };
      continue;
    }
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    if (e.source === "literal" && typeof e.value === "string") {
      result[ghlFieldId] = { source: "literal", value: e.value };
    } else if (e.source === "column" && typeof e.columnKey === "string") {
      result[ghlFieldId] = { source: "column", columnKey: e.columnKey };
    }
  }
  return result;
}
