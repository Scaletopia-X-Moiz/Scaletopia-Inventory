"use client";

import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { Loader2, Rocket, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";
import { runSse } from "@/components/shared/use-sse-run";
import { fetchActiveClients } from "@/lib/data/active-clients-client";
import { useRegisterDialogOpen } from "@/components/shared/dialog-stack";
import type {
  EmailBisonCampaignPushResult,
  EmailBisonCampaignPushProgress,
} from "@/lib/emailbison/push-to-emailbison";
import type { EmailBisonCampaign, EmailBisonSenderEmail } from "@/lib/emailbison/client";

const WEEKDAYS: { key: DayKey; label: string }[] = [
  { key: "monday", label: "Mon" },
  { key: "tuesday", label: "Tue" },
  { key: "wednesday", label: "Wed" },
  { key: "thursday", label: "Thu" },
  { key: "friday", label: "Fri" },
  { key: "saturday", label: "Sat" },
  { key: "sunday", label: "Sun" },
];

type DayKey = "monday" | "tuesday" | "wednesday" | "thursday" | "friday" | "saturday" | "sunday";

const DEFAULT_DAYS: Record<DayKey, boolean> = {
  monday: true,
  tuesday: true,
  wednesday: true,
  thursday: true,
  friday: true,
  saturday: false,
  sunday: false,
};

/** One sequence-step row in the create-campaign form (issue #94/#101),
 * camelCase mirror of lib/emailbison/client.ts's EmailBisonSequenceStepInput
 * plus a local `key` for React list identity independent of array index. */
interface SequenceStepForm {
  key: string;
  emailSubject: string;
  emailBody: string;
  waitInDays: string;
}

function newSequenceStep(): SequenceStepForm {
  return {
    key: Math.random().toString(36).slice(2),
    emailSubject: "",
    emailBody: "",
    waitInDays: "0",
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
    timezone: "UTC",
    steps: [newSequenceStep()],
  };
}

interface ActiveClient {
  id: string;
  name: string;
  hasEmailBisonCredentials: boolean;
}

type SseEvent =
  | ({ type: "progress" } & EmailBisonCampaignPushProgress)
  | { type: "done"; action: "campaign"; result: EmailBisonCampaignPushResult; note: string }
  | { type: "error"; message: string };

type Status = "idle" | "open" | "pushing";
type Step = "picker" | "campaign" | "confirm" | "summary";

/** "Add to Campaign", the second EmailBison push action (ADR 0003, issue
 * #63) — attaches the current filtered People to a live-fetched campaign.
 * Any person missing a prior EmailBison lead id is silently upserted first
 * (runEmailBisonAddToCampaign, ticket #59); this button never needs "Add to
 * EmailBison" to have run first. */
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

  // "+ Create a campaign" inline form state (issue #94/#101) — swapped in
  // alongside the existing campaign <select> in the `campaign` step.
  const [creatingCampaign, setCreatingCampaign] = useState(false);
  const [createForm, setCreateForm] = useState<CreateCampaignForm>(newCreateCampaignForm);
  const [senderEmails, setSenderEmails] = useState<EmailBisonSenderEmail[] | null>(null);
  const [senderEmailsError, setSenderEmailsError] = useState<string | null>(null);
  const [createCampaignError, setCreateCampaignError] = useState<string | null>(null);
  const [createCampaignBusy, setCreateCampaignBusy] = useState<"draft" | "launch" | null>(null);

  const [result, setResult] = useState<EmailBisonCampaignPushResult | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const busy = status === "pushing";
  const selectedClient = clients?.find((c) => c.id === selectedClientId) ?? null;
  const selectedCampaign = campaigns?.find((c) => c.id === selectedCampaignId) ?? null;

  // Registers this dialog (including its persistent "Push complete" summary
  // step) with the shared dialog stack so other prompts — e.g. the post-push
  // "remove temporary columns?" prompt — know not to open on top of it
  // (issue #89).
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
    setResult(null);
    setNote(null);
    setCreatingCampaign(false);
    setCreateForm(newCreateCampaignForm());
    setSenderEmails(null);
    setSenderEmailsError(null);
    setCreateCampaignError(null);
    setCreateCampaignBusy(null);
  }

  async function handleClick() {
    if (busy) return;
    if (total === 0) {
      showToast("No people match the current filters.", "info");
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

  async function handleShowCreateCampaign() {
    if (!selectedClient) return;
    setCreatingCampaign(true);
    setCreateForm(newCreateCampaignForm());
    setCreateCampaignError(null);
    setSenderEmails(null);
    setSenderEmailsError(null);

    try {
      const res = await fetch(`/api/clients/${selectedClient.id}/emailbison-sender-emails`);
      if (!res.ok) throw new Error("Failed to load sender emails");
      const data = (await res.json()) as { senderEmails: EmailBisonSenderEmail[] };
      setSenderEmails(data.senderEmails);
    } catch (error) {
      setSenderEmailsError((error as Error).message || "Failed to load sender emails.");
    }
  }

  function handleCancelCreateCampaign() {
    setCreatingCampaign(false);
    setCreateForm(newCreateCampaignForm());
    setCreateCampaignError(null);
    setSenderEmails(null);
    setSenderEmailsError(null);
  }

  function toggleSenderEmail(id: string) {
    setCreateForm((form) => ({
      ...form,
      senderEmailIds: form.senderEmailIds.includes(id)
        ? form.senderEmailIds.filter((existing) => existing !== id)
        : [...form.senderEmailIds, id],
    }));
  }

  function toggleDay(day: DayKey) {
    setCreateForm((form) => ({ ...form, days: { ...form.days, [day]: !form.days[day] } }));
  }

  function updateStep(key: string, patch: Partial<SequenceStepForm>) {
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

  async function handleSubmitCreateCampaign(launch: boolean) {
    if (!selectedClient) return;
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
          sequenceSteps: createForm.steps.map((step) => ({
            emailSubject: step.emailSubject,
            emailBody: step.emailBody,
            waitInDays: Number(step.waitInDays) || 0,
            threadReply: false,
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
      setSelectedCampaignId(created.id);
      setCreatingCampaign(false);
      setCreateForm(newCreateCampaignForm());
      setSenderEmails(null);
      setSenderEmailsError(null);
    } catch (error) {
      setCreateCampaignError((error as Error).message || "Failed to create campaign.");
    } finally {
      setCreateCampaignBusy(null);
    }
  }

  async function handleConfirm() {
    if (!selectedClient || !selectedCampaign) return;

    setStatus("pushing");
    setPushLabel("Pushing…");
    let reachedDone = false;

    try {
      await runSse<SseEvent>(
        `/api/emailbison/push?${paramsStr}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            entity: "people",
            action: "campaign",
            clientId: selectedClient.id,
            campaignId: selectedCampaign.id,
            parallel,
          }),
        },
        (event) => {
          if (event.type === "done") reachedDone = true;
          handleSseEvent(event);
        }
      );
    } catch (error) {
      showToast((error as Error).message || "Push interrupted — try again.", "error");
      console.error("Add to Campaign stream error:", error);
      reset();
      return;
    }

    // A terminal `{type: "error"}` frame (e.g. missing EmailBison credentials)
    // closes the stream without ever sending `done` — treat that as a failed
    // run and close the dialog rather than leaving it stuck mid-"pushing".
    if (!reachedDone) {
      reset();
      return;
    }

    setPushLabel(null);
  }

  function handleSseEvent(event: SseEvent) {
    if (event.type === "progress") {
      const phaseLabel =
        event.phase === "resolving"
          ? "Resolving…"
          : event.phase === "adding-to-workspace"
            ? `Adding to workspace ${event.done}/${event.total}…`
            : event.phase === "attaching"
              ? `Attaching ${event.done}/${event.total}…`
              : null;
      if (phaseLabel) setPushLabel(phaseLabel);
      return;
    }

    if (event.type === "error") {
      showToast(event.message, "error");
      return;
    }

    if (event.type === "done") {
      setResult(event.result);
      setNote(event.note);
      setStatus("open");
      setStep("summary");
      onDone?.();
    }
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
              the <strong className="text-ink">{total.toLocaleString("en-US")}</strong> people in
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
          <AlertDialog.Content className="fixed top-[10%] left-1/2 z-50 w-full max-w-lg -translate-x-1/2 max-h-[80vh] overflow-y-auto rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Campaign &amp; run settings
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <div className="mt-4 flex flex-col gap-5 text-sm text-ink-soft">
                {creatingCampaign ? (
                  <div>
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-ink">Create a campaign</p>
                      <button
                        type="button"
                        onClick={handleCancelCreateCampaign}
                        className="text-xs text-ink-mute hover:text-ink"
                      >
                        ← Back to picker
                      </button>
                    </div>

                    <div className="mt-3 flex flex-col gap-4">
                      <div>
                        <label className="block text-xs font-medium text-ink">Name</label>
                        <input
                          type="text"
                          value={createForm.name}
                          onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                          className="mt-1 w-full rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                          placeholder="Campaign name"
                        />
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-ink">Sender emails</label>
                        <div className="mt-1 flex max-h-32 flex-col gap-1 overflow-y-auto rounded-md border border-rule p-2">
                          {senderEmailsError ? (
                            <p className="text-xs text-danger">{senderEmailsError}</p>
                          ) : senderEmails === null ? (
                            <p className="flex items-center gap-2 text-xs text-ink-soft">
                              <Loader2 size={12} className="animate-spin" />
                              Loading sender emails…
                            </p>
                          ) : senderEmails.length === 0 ? (
                            <p className="text-xs text-ink-mute">No sender emails in this workspace yet.</p>
                          ) : (
                            senderEmails.map((sender) => (
                              <label key={sender.id} className="flex items-center gap-2 text-xs">
                                <input
                                  type="checkbox"
                                  checked={createForm.senderEmailIds.includes(sender.id)}
                                  onChange={() => toggleSenderEmail(sender.id)}
                                />
                                <span className="text-ink">{sender.name}</span>
                                <span className="text-ink-mute">{sender.email}</span>
                              </label>
                            ))
                          )}
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-ink">Schedule</label>
                        <div className="mt-1 flex flex-wrap gap-2">
                          {WEEKDAYS.map((day) => (
                            <label
                              key={day.key}
                              className="flex items-center gap-1 rounded-md border border-rule px-2 py-1 text-xs"
                            >
                              <input
                                type="checkbox"
                                checked={createForm.days[day.key]}
                                onChange={() => toggleDay(day.key)}
                              />
                              <span className="text-ink">{day.label}</span>
                            </label>
                          ))}
                        </div>
                        <div className="mt-2 flex items-center gap-2">
                          <input
                            type="time"
                            value={createForm.startTime}
                            onChange={(e) => setCreateForm((f) => ({ ...f, startTime: e.target.value }))}
                            className="rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                          />
                          <span className="text-xs text-ink-mute">to</span>
                          <input
                            type="time"
                            value={createForm.endTime}
                            onChange={(e) => setCreateForm((f) => ({ ...f, endTime: e.target.value }))}
                            className="rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                          />
                          <select
                            value={createForm.timezone}
                            onChange={(e) => setCreateForm((f) => ({ ...f, timezone: e.target.value }))}
                            className="rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                          >
                            <option value="UTC">UTC</option>
                            <option value="America/New_York">America/New_York</option>
                            <option value="America/Chicago">America/Chicago</option>
                            <option value="America/Denver">America/Denver</option>
                            <option value="America/Los_Angeles">America/Los_Angeles</option>
                            <option value="Europe/London">Europe/London</option>
                          </select>
                        </div>
                      </div>

                      <div>
                        <label className="block text-xs font-medium text-ink">Sequence steps</label>
                        <div className="mt-1 flex flex-col gap-3">
                          {createForm.steps.map((step, index) => (
                            <div key={step.key} className="rounded-md border border-rule p-2">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-medium text-ink">Step {index + 1}</span>
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
                              <input
                                type="text"
                                value={step.emailSubject}
                                onChange={(e) => updateStep(step.key, { emailSubject: e.target.value })}
                                placeholder="Subject"
                                className="mt-2 w-full rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                              />
                              <textarea
                                value={step.emailBody}
                                onChange={(e) => updateStep(step.key, { emailBody: e.target.value })}
                                placeholder="Body"
                                rows={3}
                                className="mt-2 w-full rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                              />
                              <div className="mt-2 flex items-center gap-2">
                                <span className="text-xs text-ink-mute">Wait</span>
                                <input
                                  type="number"
                                  min={0}
                                  value={step.waitInDays}
                                  onChange={(e) => updateStep(step.key, { waitInDays: e.target.value })}
                                  className="w-16 rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                                />
                                <span className="text-xs text-ink-mute">days</span>
                              </div>
                            </div>
                          ))}
                          <button
                            type="button"
                            onClick={addStep}
                            className="self-start text-xs text-stamp hover:underline"
                          >
                            + Add another step
                          </button>
                        </div>
                      </div>

                      {createCampaignError ? (
                        <p className="text-xs text-danger">{createCampaignError}</p>
                      ) : null}

                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => handleSubmitCreateCampaign(false)}
                          disabled={createCampaignBusy !== null}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink transition-smooth hover:bg-hover focus-visible:ring-2 focus-visible:ring-stamp/50",
                            createCampaignBusy !== null && "opacity-50 cursor-not-allowed"
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
                          disabled={createCampaignBusy !== null}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-md bg-danger px-3 py-1.5 text-xs font-medium text-white transition-smooth hover:opacity-90 focus-visible:ring-2 focus-visible:ring-danger/50",
                            createCampaignBusy !== null && "opacity-50 cursor-not-allowed"
                          )}
                        >
                          {createCampaignBusy === "launch" ? (
                            <Loader2 size={12} className="animate-spin" />
                          ) : (
                            <TriangleAlert size={12} />
                          )}
                          Launch Campaign
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div>
                      <p className="text-xs font-medium text-ink">Campaign</p>
                      <p className="mt-1 text-xs text-ink-mute">
                        Live-fetched from {selectedClient?.name}&apos;s EmailBison workspace.
                      </p>
                      <div className="mt-2">
                        {campaignsError ? (
                          <p className="text-xs text-danger">{campaignsError}</p>
                        ) : campaigns === null ? (
                          <p className="flex items-center gap-2 text-xs text-ink-soft">
                            <Loader2 size={12} className="animate-spin" />
                            Loading campaigns…
                          </p>
                        ) : (
                          <div className="flex flex-col gap-2">
                            {campaigns.length === 0 ? (
                              <p className="text-xs text-ink-mute">No campaigns in this workspace yet.</p>
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
                              className="self-start text-xs text-stamp hover:underline"
                            >
                              + Create a campaign
                            </button>
                          </div>
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

            {!creatingCampaign ? (
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
                  onClick={handleConfirmCampaign}
                  disabled={!selectedCampaign}
                  className={cn(
                    "rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                    selectedCampaign ? "bg-stamp hover:opacity-90" : "bg-stamp/40 cursor-not-allowed"
                  )}
                >
                  Continue →
                </button>
              </div>
            ) : null}
          </AlertDialog.Content>
        ) : step === "confirm" ? (
          <AlertDialog.Content className="fixed top-[26%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Add to {selectedCampaign?.name}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              <strong className="text-ink">{total.toLocaleString("en-US")}</strong> people in the
              current view will be queued for this campaign on {selectedClient?.name}&apos;s
              EmailBison workspace. Anyone not already an EmailBison lead is added first,
              automatically. No quality filter is applied — this is exactly the currently
              filtered/selected set.
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
        ) : (
          <AlertDialog.Content className="fixed top-[26%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Push complete
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <div className="mt-2 text-sm text-ink-soft">
                {result ? (
                  <ul className="flex flex-col gap-1">
                    <li>
                      Queued for campaign: <strong className="text-ink">{result.attached}</strong>
                    </li>
                    <li>
                      Failed: <strong className="text-ink">{result.errors}</strong>
                    </li>
                    {result.failed.length > 0 ? (
                      <li className="mt-1 flex flex-col gap-0.5 text-xs text-ink-mute">
                        {result.failed.slice(0, 5).map((f, i) => (
                          <span key={i}>
                            Failed: {f.name} — {f.reason}
                          </span>
                        ))}
                        {result.failed.length > 5 ? (
                          <span>…and {result.failed.length - 5} more</span>
                        ) : null}
                      </li>
                    ) : null}
                    {note ? <li className="mt-2 text-xs text-ink-mute">{note}</li> : null}
                  </ul>
                ) : null}
              </div>
            </AlertDialog.Description>

            <div className="mt-5 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button
                  type="button"
                  onClick={reset}
                  className="rounded-md bg-stamp px-3 py-1.5 text-xs font-medium text-white transition-smooth hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stamp/50"
                >
                  Close
                </button>
              </AlertDialog.Cancel>
            </div>
          </AlertDialog.Content>
        )}
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
