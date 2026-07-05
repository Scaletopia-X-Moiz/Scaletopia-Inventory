const BLOCKED_KEYS = new Set([
  "naics",
  "aiark_id",
  "industries",
  "legal_name",
  "ai_ark_approaches",
  "pushed_to_clay",
  "created_at",
  "updated_at",
  "company_type",
]);

function isHousekeepingKey(key: string): boolean {
  return BLOCKED_KEYS.has(key) || key.startsWith("pushed_to_") || key.endsWith("_at");
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (value === "") return true;
  if (Array.isArray(value) && value.length === 0) return true;
  return false;
}

/** Applies the Company/Person Detail custom_data display rules: drop
 * housekeeping keys and any key whose value is null/empty string/empty array.
 * `extraBlockedKeys` lets Person Detail layer on its additional blocklist. */
export function filterCustomData(
  raw: Record<string, unknown> | null | undefined,
  extraBlockedKeys: readonly string[] = []
): Record<string, unknown> {
  if (!raw) return {};
  const extra = new Set(extraBlockedKeys);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (isHousekeepingKey(key) || extra.has(key)) continue;
    if (isEmptyValue(value)) continue;
    result[key] = value;
  }
  return result;
}

const WEBHOOK_BLOCKED_KEYS = new Set(["pushed_to_clay", "pushed_to_clay_at"]);

/** Prepares custom_data for the Clay webhook payload. This is deliberately NOT
 * `filterCustomData`: that function drops housekeeping keys, empty values, and
 * any key ending in `_at` for UI display purposes, which also silently strips
 * real enrichment data (e.g. `founded_at`) from what gets sent to Clay. Clay
 * should receive every stored key verbatim except the two that only track our
 * own push bookkeeping. */
export function toWebhookCustomData(
  raw: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!raw) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (WEBHOOK_BLOCKED_KEYS.has(key)) continue;
    result[key] = value;
  }
  return result;
}
