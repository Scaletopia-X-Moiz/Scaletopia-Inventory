import { describe, expect, it } from "vitest";
import {
  DEFAULT_CAMPAIGN_SETTINGS,
  campaignSettingsFormErrors,
  parseCampaignSettings,
  toWireCampaignSettings,
} from "@/lib/emailbison/campaign-settings";

describe("toWireCampaignSettings", () => {
  it("maps camelCase to snake_case", () => {
    expect(
      toWireCampaignSettings({
        maxEmailsPerDay: 50,
        maxNewLeadsPerDay: 20,
        plainText: true,
        openTracking: true,
        reputationBuilding: true,
        canUnsubscribe: false,
        includeAutoRepliesInStats: false,
        maxSendsPerReceivingDomain: 10,
        sequencePrioritization: "new_leads",
      })
    ).toEqual({
      max_emails_per_day: 50,
      max_new_leads_per_day: 20,
      plain_text: true,
      open_tracking: true,
      reputation_building: true,
      can_unsubscribe: false,
      include_auto_replies_in_stats: false,
      daily_max_sends_per_receiving_domain: 10,
      sequence_prioritization: "new_leads",
    });
  });

  it("never sends unsubscribe_text (EmailBison ignores it)", () => {
    const wire = toWireCampaignSettings({ ...DEFAULT_CAMPAIGN_SETTINGS, canUnsubscribe: true });
    expect("unsubscribe_text" in wire).toBe(false);
  });
});

describe("parseCampaignSettings", () => {
  it("returns the defaults for undefined/null", () => {
    expect(parseCampaignSettings(undefined)).toEqual({ ok: true, value: DEFAULT_CAMPAIGN_SETTINGS });
    expect(parseCampaignSettings(null)).toEqual({ ok: true, value: DEFAULT_CAMPAIGN_SETTINGS });
  });

  it("merges partial input with the defaults", () => {
    expect(parseCampaignSettings({ maxEmailsPerDay: 50, maxNewLeadsPerDay: 20, plainText: true })).toEqual({
      ok: true,
      value: { ...DEFAULT_CAMPAIGN_SETTINGS, maxEmailsPerDay: 50, maxNewLeadsPerDay: 20, plainText: true },
    });
  });

  it.each([
    ["zero", { maxEmailsPerDay: 0 }],
    ["negative", { maxNewLeadsPerDay: -5 }],
    ["float", { maxEmailsPerDay: 10.5 }],
    ["string", { maxEmailsPerDay: "100" }],
    ["over the upper bound", { maxEmailsPerDay: 50_001 }],
    ["emails/day below leads/day", { maxEmailsPerDay: 10, maxNewLeadsPerDay: 20 }],
    ["non-boolean toggle", { openTracking: "yes" }],
    ["non-boolean auto replies", { includeAutoRepliesInStats: "no" }],
    ["domain limit zero", { maxSendsPerReceivingDomain: 0 }],
    ["domain limit over 1000", { maxSendsPerReceivingDomain: 1001 }],
    ["domain limit float", { maxSendsPerReceivingDomain: 2.5 }],
    ["domain limit string", { maxSendsPerReceivingDomain: "25" }],
    ["unknown prioritization", { sequencePrioritization: "random" }],
    ["non-string prioritization", { sequencePrioritization: 1 }],
  ])("rejects %s", (_label, input) => {
    expect(parseCampaignSettings(input).ok).toBe(false);
  });

  it("accepts the new fields at their bounds", () => {
    expect(
      parseCampaignSettings({
        includeAutoRepliesInStats: false,
        maxSendsPerReceivingDomain: 1000,
        sequencePrioritization: "new_leads",
      })
    ).toEqual({
      ok: true,
      value: {
        ...DEFAULT_CAMPAIGN_SETTINGS,
        includeAutoRepliesInStats: false,
        maxSendsPerReceivingDomain: 1000,
        sequencePrioritization: "new_leads",
      },
    });
    expect(parseCampaignSettings({ maxSendsPerReceivingDomain: 1 }).ok).toBe(true);
  });

  it("has EmailBison's defaults for the new fields", () => {
    expect(DEFAULT_CAMPAIGN_SETTINGS).toMatchObject({
      includeAutoRepliesInStats: true,
      maxSendsPerReceivingDomain: 25,
      sequencePrioritization: "followups",
    });
  });

  it("rejects a non-object", () => {
    expect(parseCampaignSettings("nope").ok).toBe(false);
    expect(parseCampaignSettings([]).ok).toBe(false);
  });
});

describe("campaignSettingsFormErrors", () => {
  it("is empty for the defaults", () => {
    expect(campaignSettingsFormErrors(DEFAULT_CAMPAIGN_SETTINGS)).toEqual([]);
  });

  it("flags a blank or out-of-range domain limit", () => {
    for (const v of [NaN, 0, 1001]) {
      expect(campaignSettingsFormErrors({ ...DEFAULT_CAMPAIGN_SETTINGS, maxSendsPerReceivingDomain: v }).length).toBe(1);
    }
  });

  it("flags NaN (a blank number input) as invalid", () => {
    expect(campaignSettingsFormErrors({ ...DEFAULT_CAMPAIGN_SETTINGS, maxEmailsPerDay: NaN }).length).toBeGreaterThan(0);
  });
});
