/** Campaign settings EmailBison's public API can set on a campaign
 * (`PATCH /api/campaigns/{id}/update`, live-verified 2026-09-29 — see
 * docs/features/emailbison-push/api-research.md "Campaign settings").
 * Deliberately free of `server-only`: the create-campaign form (client
 * component) and the route/orchestrator (server) share these types, defaults
 * and validation so the two can't drift. */
export interface EmailBisonCampaignSettingsInput {
  maxEmailsPerDay: number;
  maxNewLeadsPerDay: number;
  plainText: boolean;
  openTracking: boolean;
  reputationBuilding: boolean;
  canUnsubscribe: boolean;
  includeAutoRepliesInStats: boolean;
  maxSendsPerReceivingDomain: number;
  sequencePrioritization: SequencePrioritization;
}

export const SEQUENCE_PRIORITIZATIONS = ["followups", "new_leads"] as const;
export type SequencePrioritization = (typeof SEQUENCE_PRIORITIZATIONS)[number];

/** EmailBison's own defaults for a fresh campaign (confirmed live on a new
 * campaign's GET), so a user who never touches the settings gets the same
 * campaign as before this section existed. */
export const DEFAULT_CAMPAIGN_SETTINGS: EmailBisonCampaignSettingsInput = {
  maxEmailsPerDay: 1000,
  maxNewLeadsPerDay: 1000,
  plainText: false,
  openTracking: false,
  reputationBuilding: false,
  canUnsubscribe: false,
  includeAutoRepliesInStats: true,
  maxSendsPerReceivingDomain: 25,
  sequencePrioritization: "followups",
};

/** Limits EmailBison enforces (live 422s): each limit is 1..50000, and
 * max_emails_per_day must be >= max_new_leads_per_day. */
export const CAMPAIGN_LIMIT_MIN = 1;
export const CAMPAIGN_LIMIT_MAX = 50_000;

/** Live 422s: daily_max_sends_per_receiving_domain must be 1..1000. */
export const DOMAIN_LIMIT_MIN = 1;
export const DOMAIN_LIMIT_MAX = 1000;

/** Maps the camelCase input to the snake_case PATCH body. */
export function toWireCampaignSettings(s: EmailBisonCampaignSettingsInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    max_emails_per_day: s.maxEmailsPerDay,
    max_new_leads_per_day: s.maxNewLeadsPerDay,
    plain_text: s.plainText,
    open_tracking: s.openTracking,
    reputation_building: s.reputationBuilding,
    can_unsubscribe: s.canUnsubscribe,
    include_auto_replies_in_stats: s.includeAutoRepliesInStats,
    daily_max_sends_per_receiving_domain: s.maxSendsPerReceivingDomain,
    sequence_prioritization: s.sequencePrioritization,
  };
  return body;
}

function isLimit(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= CAMPAIGN_LIMIT_MIN && n <= CAMPAIGN_LIMIT_MAX;
}

/** Human-readable problems with `s` (empty when valid). Shared by the form
 * (disables "Create campaign") and the route's parser, so both apply the same
 * rules. */
export function campaignSettingsFormErrors(s: EmailBisonCampaignSettingsInput): string[] {
  const errors: string[] = [];
  const range = `a whole number from ${CAMPAIGN_LIMIT_MIN} to ${CAMPAIGN_LIMIT_MAX}`;
  if (!isLimit(s.maxEmailsPerDay)) errors.push(`Max emails per day must be ${range}.`);
  if (!isLimit(s.maxNewLeadsPerDay)) errors.push(`Max new leads per day must be ${range}.`);
  if (isLimit(s.maxEmailsPerDay) && isLimit(s.maxNewLeadsPerDay) && s.maxEmailsPerDay < s.maxNewLeadsPerDay) {
    errors.push("Max emails per day must be at least the max new leads per day.");
  }
  if (
    typeof s.maxSendsPerReceivingDomain !== "number" ||
    !Number.isInteger(s.maxSendsPerReceivingDomain) ||
    s.maxSendsPerReceivingDomain < DOMAIN_LIMIT_MIN ||
    s.maxSendsPerReceivingDomain > DOMAIN_LIMIT_MAX
  ) {
    errors.push(
      `Maximum emails per receiving domain must be a whole number from ${DOMAIN_LIMIT_MIN} to ${DOMAIN_LIMIT_MAX}.`
    );
  }
  if (!SEQUENCE_PRIORITIZATIONS.includes(s.sequencePrioritization)) {
    errors.push("Sequence prioritization must be followups or new_leads.");
  }
  return errors;
}

type ParseResult = { ok: true; value: EmailBisonCampaignSettingsInput } | { ok: false; error: string };

/** Validates the untrusted `settings` field of the create-campaign route
 * body. `undefined`/`null` yields the defaults; missing keys fall back to the
 * defaults; a wrongly-typed key is rejected rather than coerced. */
export function parseCampaignSettings(raw: unknown): ParseResult {
  if (raw === undefined || raw === null) return { ok: true, value: { ...DEFAULT_CAMPAIGN_SETTINGS } };
  if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "Invalid campaign settings" };

  const input = raw as Record<string, unknown>;
  const value: EmailBisonCampaignSettingsInput = { ...DEFAULT_CAMPAIGN_SETTINGS };

  for (const key of ["maxEmailsPerDay", "maxNewLeadsPerDay", "maxSendsPerReceivingDomain"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "number") return { ok: false, error: `Invalid campaign settings: ${key} must be a number` };
    value[key] = input[key];
  }
  for (const key of ["plainText", "openTracking", "reputationBuilding", "canUnsubscribe", "includeAutoRepliesInStats"] as const) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== "boolean") return { ok: false, error: `Invalid campaign settings: ${key} must be a boolean` };
    value[key] = input[key];
  }
  if (input.sequencePrioritization !== undefined) {
    if (!(SEQUENCE_PRIORITIZATIONS as readonly unknown[]).includes(input.sequencePrioritization)) {
      return { ok: false, error: "Invalid campaign settings: sequencePrioritization must be followups or new_leads" };
    }
    value.sequencePrioritization = input.sequencePrioritization as SequencePrioritization;
  }
  const errors = campaignSettingsFormErrors(value);
  if (errors.length > 0) return { ok: false, error: `Invalid campaign settings: ${errors.join(" ")}` };
  return { ok: true, value };
}
