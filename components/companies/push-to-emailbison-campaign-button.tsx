"use client";

import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { Loader2, Rocket, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";
import { fetchActiveClients } from "@/lib/data/active-clients-client";
import { useRegisterDialogOpen } from "@/components/shared/dialog-stack";
import { SenderEmailPicker } from "@/components/emailbison/sender-email-picker";
import type { EmailBisonCampaign } from "@/lib/emailbison/client";

type DayKey = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

const WEEKDAYS: { key: DayKey; label: string }[] = [
  { key: "monday", label: "Mon" },
  { key: "tuesday", label: "Tue" },
  { key: "wednesday", label: "Wed" },
  { key: "thursday", label: "Thu" },
  { key: "friday", label: "Fri" },
  { key: "saturday", label: "Sat" },
  { key: "sunday", label: "Sun" },
];

const DEFAULT_DAYS: Record<DayKey, boolean> = {
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false,
  sunday: false,
};

/** A short, curated list of common IANA timezones for the create-campaign
 * form's schedule timezone <select> — EmailBison accepts any IANA zone name,
 * this just keeps the picker to a reasonable default set rather than every
 * zone Intl knows about. */
const TIMEZONE_OPTIONS = [
  "America/New_York",
  "America/Chicago",
  "America/Denver",
  "America/Los_Angeles",
  "America/Sao_Paulo",
  "Europe/London",
  "Europe/Berlin",
  "Europe/Madrid",
  "Africa/Lagos",
  "Africa/Cairo",
  "Asia/Dubai",
  "Asia/Karachi",
  "Asia/Kolkata",
  "Asia/Dhaka",
  "Asia/Bangkok",
  "Asia/Singapore",
  "Asia/Shanghai",
  "Asia/Tokyo",
  "Australia/Sydney",
  "Pacific/Auckland",
];

/** One split-test variant card within a sequence step (EmailBison-style "A/B
 * split test variants") — `variants[0]` on a SequenceStepForm is the base
 * ("A") content, any further entries are extra variants ("B", "C", …). Just
 * subject/body: a variant shares its step's wait/thread-reply settings. */
interface StepVariantForm {
  key: string;
  emailSubject: string;
  emailBody: string;
}

function newStepVariant(): StepVariantForm {
  return { key: Math.random().toString(36).slice(2), emailSubject: "", emailBody: "" };
}

/** One sequence-step row in the create-campaign form (issue #94/#100),
 * camelCase mirror of lib/emailbison/client.ts's EmailBisonSequenceStepInput
 * plus a local `key` for React list identity independent of array index.
 * `waitInDays` stays a string while the field is being edited so an empty
 * input doesn't get coerced to 0 mid-typing. `variants` always has at least
 * one entry — index 0 is the base ("A") content, the rest are extra split
 * test variants. */
interface SequenceStepForm {
  key: string;
  waitInDays: string;
  variants: StepVariantForm[];
}

function newSequenceStep(): SequenceStepForm {
  return {
    key: Math.random().toString(36).slice(2),
    waitInDays: "0",
    variants: [newStepVariant()],
  };
}

interface CreateCampaignForm {
  name: string;
  senderEmailIds: string[];
  days: Record<DayKey, boolean>;
  startTime: string;
  endTime: string;
  timezone: string;
  steps: SequenceStepForm[];
}

function newCreateCampaignForm(): CreateCampaignForm {
  return {
    name: "",
    senderEmailIds: [],
    days: { ...DEFAULT_DAYS },
    startTime: "09:00",
    endTime: "17:00",
    timezone: "America/New_York",
    steps: [newSequenceStep()],
  };
}

interface ActiveClient {
  id: string;
  name: string;
  hasEmailBisonCredentials: boolean;
}

type Status = "idle" | "open" | "pushing";
type Step = "picker" | "campaign" | "confirm";

/** "Add to Campaign", the Companies-table counterpart of
 * push-to-emailbison-campaign-button.tsx (People table, issue #63) — resolves
 * to every Person linked to the currently filtered Companies before enrolling
 * into a live-fetched campaign, mirroring #62's relationship to #61 (ADR
 * 0003, issue #64). Anyone missing a prior EmailBison lead id is silently
 * upserted first (runEmailBisonAddToCampaign, ticket #59).
 *
 * The `campaign` step also hosts a "+ Create a campaign" inline form (issue
 * #94/#100) that creates a brand-new EmailBison campaign without leaving
 * this dialog — on success the new campaign is prepended to `campaigns` and
 * the user lands back on the normal select, same as picking an existing
 * campaign. It does not auto-continue the push (out of scope per #94). */
export function PushToEmailBisonCampaignButton({
  paramsStr,
  total,
  onDone,
}: {
  paramsStr: string;
  total: number;
  /** Fired once the push stream reaches its `done` event — mirrors
   * PushToEmailBisonButton's onDone. */
  onDone?: () => void;
}) {
  const [status, setStatus] = useState<Status>("idle");
  const [step, setStep] = useState<Step>("picker");
  const [pushLabel, setPushLabel] = useState<string | null>(null);

  const [clients, setClients] = useState<ActiveClient[] | null>(null);
  const [clientsError, setClientsError] = useState<string | null>(null);
  const [selectedClientId, setSelectedClientId] = useState<string | null>(null);

  const [campaigns, setCampaigns] = useState<EmailBisonCampaign[] | null>(null);
  const [campaignsError, setCampaignsError] = useState<string | null>(null);
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [parallel, setParallel] = useState(false);

  // "+ Create a campaign" inline form state (issue #94/#100) — swapped in
  // alongside the existing campaign <select> in the `campaign` step.
  const [creatingCampaign, setCreatingCampaign] = useState(false);
  const [createForm, setCreateForm] = useState<CreateCampaignForm>(newCreateCampaignForm);
  const [createCampaignError, setCreateCampaignError] = useState<string | null>(null);
  const [createCampaignBusy, setCreateCampaignBusy] = useState<"draft" | "launch" | null>(null);

  const busy = status === "pushing";
  const selectedClient = clients?.find((c) => c.id === selectedClientId) ?? null;
  const selectedCampaign = campaigns?.find((c) => c.id === selectedCampaignId) ?? null;

  const createFormValid =
    createForm.name.trim().length > 0 &&
    createForm.senderEmailIds.length > 0 &&
    createForm.steps.length > 0 &&
    createForm.steps.every(
      (s) =>
        s.variants.length > 0 &&
        s.variants.every((v) => v.emailSubject.trim().length > 0 && v.emailBody.trim().length > 0)
    );

  // Registers this dialog with the shared dialog stack so other prompts — e.g.
  // the post-push "remove temporary columns?" prompt — defer until it closes
  // rather than stacking on top of it (issue #89).
  useRegisterDialogOpen(status !== "idle");

  function reset() {
    setStatus("idle");
    setStep("picker");
    setPushLabel(null);
    setClients(null);
    setClientsError(null);
    setSelectedClientId(null);
    setCampaigns(null);
    setCampaignsError(null);
    setSelectedCampaignId(null);
    setParallel(false);
    setCreatingCampaign(false);
    setCreateForm(newCreateCampaignForm());
    setCreateCampaignError(null);
    setCreateCampaignBusy(null);
  }

  async function handleClick() {
    if (busy) return;
    if (total === 0) {
      showToast("No companies match the current filters.", "info");
      return;
    }
    setStep("picker");
    setStatus("open");
    setClients(null);
    setClientsError(null);
    setSelectedClientId(null);

    try {
      const data = await fetchActiveClients<{ clients: ActiveClient[] }>();
      setClients(data.clients);
    } catch (error) {
      setClientsError((error as Error).message || "Failed to load clients.");
    }
  }

  function handleCancel() {
    if (busy) return;
    reset();
  }

  async function handleContinueFromPicker() {
    if (!selectedClient || !selectedClient.hasEmailBisonCredentials) return;

    setStep("campaign");
    setCampaigns(null);
    setCampaignsError(null);
    setSelectedCampaignId(null);

    try {
      const res = await fetch(`/api/clients/${selectedClient.id}/emailbison-campaigns`);
      if (!res.ok) throw new Error("Failed to load campaigns");
      const data = (await res.json()) as { campaigns: EmailBisonCampaign[] };
      setCampaigns(data.campaigns);
    } catch (error) {
      setCampaignsError((error as Error).message || "Failed to load campaigns.");
    }
  }

  function handleConfirmCampaign() {
    if (!selectedCampaign) return;
    setStep("confirm");
  }

  function handleShowCreateCampaign() {
    if (!selectedClient) return;
    setCreatingCampaign(true);
    setCreateForm(newCreateCampaignForm());
    setCreateCampaignError(null);
  }

  function handleCancelCreateCampaign() {
    setCreatingCampaign(false);
    setCreateForm(newCreateCampaignForm());
    setCreateCampaignError(null);
  }

  function toggleDay(day: DayKey) {
    setCreateForm((form) => ({ ...form, days: { ...form.days, [day]: !form.days[day] } }));
  }

  function updateStep(key: string, patch: Partial<Omit<SequenceStepForm, "variants">>) {
    setCreateForm((form) => ({
      ...form,
      steps: form.steps.map((step) => (step.key === key ? { ...step, ...patch } : step)),
    }));
  }

  function addStep() {
    setCreateForm((form) => ({ ...form, steps: [...form.steps, newSequenceStep()] }));
  }

  function removeStep(key: string) {
    setCreateForm((form) => ({
      ...form,
      steps: form.steps.length > 1 ? form.steps.filter((step) => step.key !== key) : form.steps,
    }));
  }

  function updateVariant(stepKey: string, variantKey: string, patch: Partial<StepVariantForm>) {
    setCreateForm((form) => ({
      ...form,
      steps: form.steps.map((step) =>
        step.key === stepKey
          ? {
              ...step,
              variants: step.variants.map((variant) =>
                variant.key === variantKey ? { ...variant, ...patch } : variant
              ),
            }
          : step
      ),
    }));
  }

  function addVariant(stepKey: string) {
    setCreateForm((form) => ({
      ...form,
      steps: form.steps.map((step) =>
        step.key === stepKey ? { ...step, variants: [...step.variants, newStepVariant()] } : step
      ),
    }));
  }

  function removeVariant(stepKey: string, variantKey: string) {
    setCreateForm((form) => ({
      ...form,
      steps: form.steps.map((step) =>
        step.key === stepKey && step.variants.length > 1
          ? { ...step, variants: step.variants.filter((variant) => variant.key !== variantKey) }
          : step
      ),
    }));
  }

  async function handleSubmitCreateCampaign(launch: boolean) {
    if (!selectedClient || !createFormValid || createCampaignBusy) return;
    setCreateCampaignError(null);
    setCreateCampaignBusy(launch ? "launch" : "draft");

    try {
      const res = await fetch(`/api/clients/${selectedClient.id}/emailbison-campaigns`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: createForm.name,
          senderEmailIds: createForm.senderEmailIds,
          schedule: {
            ...createForm.days,
            startTime: createForm.startTime,
            endTime: createForm.endTime,
            timezone: createForm.timezone,
          },
          sequenceSteps: createForm.steps.map((step, i) => ({
            emailSubject: step.variants[0].emailSubject,
            emailBody: step.variants[0].emailBody,
            // EmailBison requires wait_in_days >= 1 for every step, including
            // the first — but "wait days after the previous step" is
            // meaningless for step 1 (no previous step), so the UI doesn't
            // render a control for it (see `i > 0` below) and we force the
            // wire value here rather than exposing a nonsensical input.
            waitInDays: i === 0 ? 1 : Number(step.waitInDays) || 0,
            threadReply: false,
            extraVariants: step.variants.slice(1).map((variant) => ({
              emailSubject: variant.emailSubject,
              emailBody: variant.emailBody,
            })),
          })),
          launch,
        }),
      });
      const data = (await res.json()) as { campaign?: EmailBisonCampaign; error?: string };
      if (!res.ok || !data.campaign) {
        throw new Error(data.error || "Failed to create campaign.");
      }

      const created = data.campaign;
      setCampaigns((prev) => (prev ? [created, ...prev] : [created]));
      setCreatingCampaign(false);
      setCreateForm(newCreateCampaignForm());
    } catch (error) {
      setCreateCampaignError((error as Error).message || "Failed to create campaign.");
    } finally {
      setCreateCampaignBusy(null);
    }
  }

  async function handleConfirm() {
    if (!selectedClient || !selectedCampaign) return;

    setStatus("pushing");
    setPushLabel("Queuing…");

    // Pushes now run as durable background jobs (issue #120): POST enqueues a
    // push_jobs row and returns immediately. Rather than block the dialog on
    // the run, we toast and close — live progress and the completion summary
    // live in the Push Activity panel (issue #122).
    try {
      const res = await fetch(`/api/emailbison/push?${paramsStr}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: "companies",
          action: "campaign",
          clientId: selectedClient.id,
          campaignId: selectedCampaign.id,
          parallel,
        }),
      });
      if (!res.ok) {
        const message = (await res.json().catch(() => null))?.error ?? "Failed to start push";
        throw new Error(message);
      }
    } catch (error) {
      showToast((error as Error).message || "Failed to queue push — try again.", "error");
      console.error("Add to Campaign error:", error);
      reset();
      return;
    }

    showToast("Push queued — track it in Push Activity", "success");
    onDone?.();
    reset();
  }

  const label = status === "pushing" && pushLabel ? pushLabel : "Add to EmailBison Campaign";

  return (
    <AlertDialog.Root open={status !== "idle"} onOpenChange={(open) => !open && handleCancel()}>
      <button
        onClick={handleClick}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-2 rounded-md border border-rule px-3 py-1.5 text-xs font-medium transition-smooth",
          busy
            ? "opacity-50 cursor-not-allowed"
            : "text-ink hover:bg-hover active:bg-hover/75 focus-visible:ring-2 focus-visible:ring-stamp/50"
        )}
        aria-label="Add to EmailBison Campaign"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <Rocket size={14} />}
        {label}
      </button>

      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />

        {step === "picker" ? (
          <AlertDialog.Content className="fixed top-[24%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Add to Campaign — choose a client
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              Select which client&apos;s EmailBison workspace owns the campaign that will receive
              every person linked to the{" "}
              <strong className="text-ink">{total.toLocaleString("en-US")}</strong> companies in
              the current view.
            </AlertDialog.Description>

            <div className="mt-4 flex max-h-64 flex-col gap-1 overflow-y-auto">
              {clientsError ? (
                <p className="text-xs text-danger">{clientsError}</p>
              ) : clients === null ? (
                <p className="flex items-center gap-2 text-xs text-ink-soft">
                  <Loader2 size={12} className="animate-spin" />
                  Loading clients…
                </p>
              ) : clients.length === 0 ? (
                <p className="text-xs text-ink-soft">No active clients found.</p>
              ) : (
                clients.map((client) => (
                  <label
                    key={client.id}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-md border border-rule px-3 py-2 text-xs",
                      client.hasEmailBisonCredentials ? "cursor-pointer hover:bg-hover" : "opacity-50"
                    )}
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="emailbison-campaign-client"
                        value={client.id}
                        checked={selectedClientId === client.id}
                        disabled={!client.hasEmailBisonCredentials}
                        onChange={() => setSelectedClientId(client.id)}
                      />
                      <span className="font-medium text-ink">{client.name}</span>
                    </span>
                    {!client.hasEmailBisonCredentials ? (
                      <span className="text-ink-mute">No EmailBison credentials</span>
                    ) : null}
                  </label>
                ))
              )}
            </div>

            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className="rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink transition-smooth hover:bg-hover focus-visible:ring-2 focus-visible:ring-stamp/50"
                >
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <button
                type="button"
                onClick={handleContinueFromPicker}
                disabled={!selectedClient?.hasEmailBisonCredentials}
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                  selectedClient?.hasEmailBisonCredentials
                    ? "bg-stamp hover:opacity-90"
                    : "bg-stamp/40 cursor-not-allowed"
                )}
              >
                Continue →
              </button>
            </div>
          </AlertDialog.Content>
        ) : step === "campaign" ? (
          <AlertDialog.Content className="fixed top-[10%] left-1/2 z-50 max-h-[80vh] w-full max-w-3xl -translate-x-1/2 overflow-y-auto rounded-xl border border-rule bg-popover p-6 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              {creatingCampaign ? "Create a campaign" : "Campaign & run settings"}
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <div className="mt-4 flex flex-col gap-6 text-sm text-ink-soft">
                {creatingCampaign ? (
                  <>
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                      <div>
                        <p className="text-xs font-semibold text-ink">Name</p>
                        <input
                          type="text"
                          value={createForm.name}
                          onChange={(e) =>
                            setCreateForm((form) => ({ ...form, name: e.target.value }))
                          }
                          placeholder="Campaign name"
                          className="mt-1.5 w-full rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                        />
                      </div>

                      <div>
                        <p className="text-xs font-semibold text-ink">Schedule</p>
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {WEEKDAYS.map((day) => (
                            <label
                              key={day.key}
                              className={cn(
                                "flex cursor-pointer items-center gap-1 rounded-md border border-rule px-2 py-1 text-xs",
                                createForm.days[day.key] ? "bg-stamp/10 text-ink" : "text-ink-mute"
                              )}
                            >
                              <input
                                type="checkbox"
                                className="sr-only"
                                checked={createForm.days[day.key]}
                                onChange={() => toggleDay(day.key)}
                              />
                              {day.label}
                            </label>
                          ))}
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <input
                            type="time"
                            value={createForm.startTime}
                            onChange={(e) =>
                              setCreateForm((form) => ({ ...form, startTime: e.target.value }))
                            }
                            className="rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                          />
                          <span className="text-xs text-ink-mute">to</span>
                          <input
                            type="time"
                            value={createForm.endTime}
                            onChange={(e) =>
                              setCreateForm((form) => ({ ...form, endTime: e.target.value }))
                            }
                            className="rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                          />
                          <select
                            value={createForm.timezone}
                            onChange={(e) =>
                              setCreateForm((form) => ({ ...form, timezone: e.target.value }))
                            }
                            className="min-w-0 flex-1 rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                          >
                            {TIMEZONE_OPTIONS.map((tz) => (
                              <option key={tz} value={tz}>
                                {tz}
                              </option>
                            ))}
                          </select>
                        </div>
                      </div>
                    </div>

                    <div>
                      <p className="text-xs font-semibold text-ink">Sender emails</p>
                      <p className="mt-1 text-xs text-ink-mute">
                        Which of {selectedClient?.name}&apos;s connected mailboxes send from this
                        campaign.
                      </p>
                      <div className="mt-2">
                        {selectedClient ? (
                          <SenderEmailPicker
                            clientId={selectedClient.id}
                            selectedIds={createForm.senderEmailIds}
                            onChange={(senderEmailIds) => setCreateForm((form) => ({ ...form, senderEmailIds }))}
                          />
                        ) : null}
                      </div>
                    </div>

                    <div>
                      <p className="text-xs font-semibold text-ink">Sequence steps</p>
                      <div className="mt-2 flex flex-col gap-3">
                        {createForm.steps.map((step, i) => (
                          <div
                            key={step.key}
                            className="rounded-lg border border-rule bg-hover/40 p-3"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-ink">Step {i + 1}</span>
                              <div className="flex items-center gap-3">
                                {i > 0 ? (
                                  <label className="flex items-center gap-1.5 text-xs text-ink-mute">
                                    Wait
                                    <input
                                      type="number"
                                      min={0}
                                      value={step.waitInDays}
                                      onChange={(e) =>
                                        updateStep(step.key, { waitInDays: e.target.value })
                                      }
                                      className="w-14 rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                                    />
                                    days after previous
                                  </label>
                                ) : null}
                                {createForm.steps.length > 1 ? (
                                  <button
                                    type="button"
                                    onClick={() => removeStep(step.key)}
                                    className="text-xs text-ink-mute hover:text-danger"
                                  >
                                    Remove
                                  </button>
                                ) : null}
                              </div>
                            </div>

                            <div className="mt-2.5 flex flex-col gap-2">
                              {step.variants.map((variant, vi) => (
                                <div
                                  key={variant.key}
                                  className="rounded-md border border-rule bg-popover p-2.5"
                                >
                                  <div className="flex items-center justify-between">
                                    <span className="text-xs font-semibold text-ink">
                                      Variant {String.fromCharCode(65 + vi)}
                                    </span>
                                    {step.variants.length > 1 ? (
                                      <button
                                        type="button"
                                        onClick={() => removeVariant(step.key, variant.key)}
                                        className="text-xs text-ink-mute hover:text-danger"
                                      >
                                        Remove
                                      </button>
                                    ) : null}
                                  </div>
                                  <input
                                    type="text"
                                    value={variant.emailSubject}
                                    onChange={(e) =>
                                      updateVariant(step.key, variant.key, { emailSubject: e.target.value })
                                    }
                                    placeholder="Subject"
                                    className="mt-2 w-full rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                                  />
                                  <textarea
                                    value={variant.emailBody}
                                    onChange={(e) =>
                                      updateVariant(step.key, variant.key, { emailBody: e.target.value })
                                    }
                                    placeholder="Body"
                                    rows={3}
                                    className="mt-2 w-full rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                                  />
                                </div>
                              ))}
                            </div>
                            <button
                              type="button"
                              onClick={() => addVariant(step.key)}
                              className="mt-2.5 text-xs font-medium text-stamp hover:underline"
                            >
                              + Add split test variant
                            </button>
                          </div>
                        ))}
                      </div>
                      <button
                        type="button"
                        onClick={addStep}
                        className="mt-2 text-xs font-medium text-stamp hover:underline"
                      >
                        + Add another step
                      </button>
                    </div>

                    {createCampaignError ? (
                      <p className="text-xs text-danger">{createCampaignError}</p>
                    ) : null}
                  </>
                ) : (
                  <>
                    <div>
                      <p className="text-xs font-medium text-ink">Campaign</p>
                      <p className="mt-1 text-xs text-ink-mute">
                        Live-fetched from {selectedClient?.name}&apos;s EmailBison workspace.
                      </p>
                      <div className="mt-2 flex flex-col gap-2">
                        {campaignsError ? (
                          <p className="text-xs text-danger">{campaignsError}</p>
                        ) : campaigns === null ? (
                          <p className="flex items-center gap-2 text-xs text-ink-soft">
                            <Loader2 size={12} className="animate-spin" />
                            Loading campaigns…
                          </p>
                        ) : (
                          <>
                            {campaigns.length === 0 ? (
                              <p className="text-xs text-ink-mute">
                                No campaigns in this workspace yet.
                              </p>
                            ) : (
                              <select
                                value={selectedCampaignId ?? ""}
                                onChange={(e) => setSelectedCampaignId(e.target.value || null)}
                                className="w-full rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                              >
                                <option value="">Select a campaign…</option>
                                {campaigns.map((campaign) => (
                                  <option key={campaign.id} value={campaign.id}>
                                    {campaign.name}
                                  </option>
                                ))}
                              </select>
                            )}
                            <button
                              type="button"
                              onClick={handleShowCreateCampaign}
                              className="self-start text-xs font-medium text-stamp hover:underline"
                            >
                              + Create a campaign
                            </button>
                          </>
                        )}
                      </div>
                    </div>

                    <div>
                      <label className="flex items-center justify-between gap-3">
                        <span>
                          <span className="text-xs font-medium text-ink">Allow parallel sending</span>
                          <span className="mt-0.5 block text-xs text-ink-mute">
                            Off sends this campaign&apos;s leads sequentially (default); on lets
                            EmailBison send in parallel.
                          </span>
                        </span>
                        <input
                          type="checkbox"
                          checked={parallel}
                          onChange={(e) => setParallel(e.target.checked)}
                          className="shrink-0"
                        />
                      </label>
                    </div>
                  </>
                )}
              </div>
            </AlertDialog.Description>

            <div className="mt-5 flex justify-end gap-2">
              {creatingCampaign ? (
                <>
                  <button
                    type="button"
                    onClick={handleCancelCreateCampaign}
                    disabled={!!createCampaignBusy}
                    className="rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink transition-smooth hover:bg-hover focus-visible:ring-2 focus-visible:ring-stamp/50 disabled:opacity-50"
                  >
                    ← Back
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSubmitCreateCampaign(false)}
                    disabled={!createFormValid || !!createCampaignBusy}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-1.5 text-xs font-medium transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                      createFormValid && !createCampaignBusy
                        ? "text-ink hover:bg-hover"
                        : "cursor-not-allowed text-ink-mute opacity-50"
                    )}
                  >
                    {createCampaignBusy === "draft" ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : null}
                    Save as Draft
                  </button>
                  <button
                    type="button"
                    onClick={() => handleSubmitCreateCampaign(true)}
                    disabled={!createFormValid || !!createCampaignBusy}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-amber-500/50",
                      createFormValid && !createCampaignBusy
                        ? "bg-amber-600 hover:opacity-90"
                        : "cursor-not-allowed bg-amber-600/40"
                    )}
                  >
                    {createCampaignBusy === "launch" ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : (
                      <TriangleAlert size={12} />
                    )}
                    Launch Campaign
                  </button>
                </>
              ) : (
                <>
                  <AlertDialog.Cancel asChild>
                    <button
                      type="button"
                      className="rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink transition-smooth hover:bg-hover focus-visible:ring-2 focus-visible:ring-stamp/50"
                    >
                      Cancel
                    </button>
                  </AlertDialog.Cancel>
                  <button
                    type="button"
                    onClick={handleConfirmCampaign}
                    disabled={!selectedCampaign}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                      selectedCampaign ? "bg-stamp hover:opacity-90" : "bg-stamp/40 cursor-not-allowed"
                    )}
                  >
                    Continue →
                  </button>
                </>
              )}
            </div>
          </AlertDialog.Content>
        ) : (
          <AlertDialog.Content className="fixed top-[26%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Add to {selectedCampaign?.name}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              Every person linked to the{" "}
              <strong className="text-ink">{total.toLocaleString("en-US")}</strong> companies in
              the current view will be queued for this campaign on {selectedClient?.name}&apos;s
              EmailBison workspace. Anyone not already an EmailBison lead is added first,
              automatically. A company with no linked people contributes nothing and won&apos;t
              error. No quality filter is applied.
            </AlertDialog.Description>

            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  className="rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink transition-smooth hover:bg-hover focus-visible:ring-2 focus-visible:ring-stamp/50"
                >
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <button
                type="button"
                onClick={handleConfirm}
                className="rounded-md bg-stamp px-3 py-1.5 text-xs font-medium text-white transition-smooth hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stamp/50"
              >
                Push {total.toLocaleString("en-US")}
              </button>
            </div>
          </AlertDialog.Content>
        )}
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
