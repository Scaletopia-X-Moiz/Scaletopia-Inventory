import { employeeBucketOf } from "@/lib/data/employee-size";
import type { GhlPushRecord } from "@/lib/ghl/types";

const UNKNOWN = "Unknown";

function segmentOrUnknown(value: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : UNKNOWN;
}

/** Builds the structured tag applied to every contact pushed to GHL:
 * `{Client Name} - {Niche} | {employee_range} | {country} | {data_source}`.
 * Each segment falls back to "Unknown" rather than being dropped, so the
 * tag's pipe-delimited shape stays stable for GHL-side automations that
 * split on it. An optional `customSuffix` (e.g. "leadership", "marketing", a
 * segment name) is appended as one more pipe-delimited segment on the end —
 * the base format is never altered, only extended. */
export function buildGhlTag(
  clientName: string,
  record: Pick<GhlPushRecord, "niche" | "employeeCount" | "country" | "source">,
  customSuffix?: string | null
): string {
  const niche = segmentOrUnknown(record.niche);
  const employeeRange = employeeBucketOf(record.employeeCount)?.label ?? UNKNOWN;
  const country = segmentOrUnknown(record.country);
  const source = segmentOrUnknown(record.source);

  const base = `${clientName} - ${niche} | ${employeeRange} | ${country} | ${source}`;
  const suffix = customSuffix?.trim();
  return suffix ? `${base} | ${suffix}` : base;
}
