"use client";

import {
  CAMPAIGN_LIMIT_MAX,
  CAMPAIGN_LIMIT_MIN,
  DOMAIN_LIMIT_MAX,
  DOMAIN_LIMIT_MIN,
  type SequencePrioritization,
  campaignSettingsFormErrors,
  type EmailBisonCampaignSettingsInput,
} from "@/lib/emailbison/campaign-settings";

type ToggleKey =
  | "openTracking"
  | "plainText"
  | "canUnsubscribe"
  | "includeAutoRepliesInStats";

// Labels and descriptions mirror EmailBison's own campaign settings page so
// operators see the same wording in both places. `reputationBuilding` has no
// EmailBison UI counterpart, so it is deliberately not offered here (it stays
// at its default, false, in the settings payload).
const TOGGLES: { key: ToggleKey; label: string; hint: string; note?: string }[] = [
  {
    key: "openTracking",
    label: "Track opens",
    hint: "Open tracking is not recommended for optimal delivery. If you don't care for deliverability, then please at least add a few custom tracking domains",
  },
  {
    key: "plainText",
    label: "Plain text emails",
    hint: "Plain text emails help boost your deliverability by removing HTML (images, links, tracking, etc.).",
  },
  {
    key: "canUnsubscribe",
    label: "Unsubscribe link",
    hint: 'Not recommended for deliverability. Add an "opt-out" text in the email instead.',
  },
  {
    key: "includeAutoRepliesInStats",
    label: "Include auto replies in stats",
    hint: "We recommend including automated replies in your stats to get a better idea of your overall inbox health. This is because if your prospect's inbox triggers an automated reply, it means your email landed in their inbox folder",
    note: "Note: this setting is not retroactive. This means that if you enable it, only future auto replies will be included. And if you disable it, only future auto replies will be ignored.",
  },
];

const PRIORITIZATION_HELP: Record<SequencePrioritization, { title: string; body: string[] }> = {
  followups: {
    title: "Prioritizing Followups",
    body: [
      "This option ensures that sequence completion is matched exactly, and followups are scheduled before new leads.",
      "If there is more sending capacity, then new leads will be scheduled.",
    ],
  },
  new_leads: {
    title: "Prioritizing New Leads",
    body: [
      "This option ensures that new leads are scheduled first, and followups use the remaining sending capacity.",
    ],
  },
};

/** Controlled "Campaign settings" block for the create-campaign form —
 * shared by the People and Companies "Add to EmailBison Campaign" buttons so
 * the two wizards can't diverge (same reason as sender-email-picker.tsx).
 * Shows the settings EmailBison's public API can set on a campaign
 * (lib/emailbison/campaign-settings.ts). Unsubscribe link text is
 * deliberately not offered: EmailBison's update endpoint silently ignores it
 * (api-research.md "Campaign settings"). A blank number input is held as NaN
 * so it fails validation instead of silently becoming 0. */
export function CampaignSettingsFields({
  value,
  onChange,
}: {
  value: EmailBisonCampaignSettingsInput;
  onChange: (next: EmailBisonCampaignSettingsInput) => void;
}) {
  const errors = campaignSettingsFormErrors(value);

  function numberField(
    label: string,
    description: string,
    key: "maxEmailsPerDay" | "maxNewLeadsPerDay" | "maxSendsPerReceivingDomain",
    min: number = CAMPAIGN_LIMIT_MIN,
    max: number = CAMPAIGN_LIMIT_MAX,
  ) {
    const current = value[key];
    return (
      <label className="flex flex-col gap-1 text-xs text-ink">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-ink-mute">{description}</span>
        <input
          type="number"
          min={min}
          max={max}
          step={1}
          value={Number.isNaN(current) ? "" : current}
          onChange={(e) =>
            onChange({
              ...value,
              [key]: e.target.value === "" ? NaN : Number(e.target.value),
            })
          }
          className="w-28 rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
        />
      </label>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <details>
        <summary className="cursor-pointer text-xs font-semibold text-ink">
          Campaign settings
        </summary>
        <div className="mt-2 flex flex-col gap-3">
          {numberField(
            "Maximum emails per day",
            "Limit how many emails your campaign can send in any given calendar day",
            "maxEmailsPerDay",
          )}
          {numberField(
            "Maximum new sequence starts per day",
            "Control how many new sequences should start per day. All other slots will then be dedicated to follow-ups.",
            "maxNewLeadsPerDay",
          )}
          <div className="flex flex-col gap-1 text-xs text-ink">
            <span className="text-sm font-medium">Email account limits</span>
            <span className="text-ink-mute">
              Your max daily limit per sending email account will automatically be respected
            </span>
          </div>
          {numberField(
            "Maximum emails per receiving domain",
            "Limit how many emails to send to a receiving domain per day. Default: 5, and does not include personal domains like gmail.com, yahoo.com, etc.",
            "maxSendsPerReceivingDomain",
            DOMAIN_LIMIT_MIN,
            DOMAIN_LIMIT_MAX,
          )}
          <label className="flex flex-col gap-1 text-xs text-ink">
            <span className="text-sm font-medium">How should sequences be prioritized?</span>
            <span className="text-ink-mute">Control how you want your sequences to be prioritized</span>
            <select
              value={value.sequencePrioritization}
              onChange={(e) =>
                onChange({
                  ...value,
                  sequencePrioritization: e.target.value as SequencePrioritization,
                })
              }
              className="w-64 rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
            >
              <option value="followups">Prioritize followups (default)</option>
              <option value="new_leads">Prioritize new leads</option>
            </select>
          </label>
          <div className="flex flex-col gap-1 rounded-md border border-rule p-3 text-xs text-ink">
            <span className="font-medium">
              {PRIORITIZATION_HELP[value.sequencePrioritization].title}
            </span>
            {PRIORITIZATION_HELP[value.sequencePrioritization].body.map((line) => (
              <span key={line} className="text-ink-mute">
                {line}
              </span>
            ))}
          </div>
          {TOGGLES.map((toggle) => (
            <label
              key={toggle.key}
              className="flex flex-row-reverse items-start justify-end gap-3 text-xs text-ink"
            >
              <span className="flex flex-col">
                <span className="text-sm font-medium">{toggle.label}</span>
                <span className="text-ink-mute">{toggle.hint}</span>
                {toggle.note ? (
                  <span className="mt-1 text-ink-mute">{toggle.note}</span>
                ) : null}
              </span>
              <input
                type="checkbox"
                checked={value[toggle.key]}
                onChange={(e) =>
                  onChange({ ...value, [toggle.key]: e.target.checked })
                }
                className="mt-0.5 shrink-0"
              />
            </label>
          ))}
        </div>
      </details>
      {errors.map((error) => (
        <p key={error} className="text-xs text-danger">
          {error}
        </p>
      ))}
    </div>
  );
}
