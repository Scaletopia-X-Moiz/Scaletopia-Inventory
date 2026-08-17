"use client";

import { useState } from "react";
import { AlertDialog } from "radix-ui";
import { Loader2, Rocket, Plus, X, Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";
import { fetchActiveClients } from "@/lib/data/active-clients-client";
import { useRegisterDialogOpen } from "@/components/shared/dialog-stack";
import { SenderEmailPicker } from "@/components/emailbison/sender-email-picker";
import type { EmailBisonCampaign, EmailBisonCustomVariable } from "@/lib/emailbison/client";
import type { EmailBisonCustomVariableEntry, EmailBisonStandardFieldMapping } from "@/lib/emailbison/types";
import type { ActiveVirtualColumn } from "@/lib/data/virtual-columns";
import type { EnrichmentField } from "@/lib/data/enrichment-fields";
import { StandardFieldMappingTable } from "@/components/emailbison/standard-field-mapping-table";
import { normalizeFieldSource } from "@/lib/emailbison/lead-payload";
import {
  fetchSavedPushFieldMapping,
  savePushFieldMapping,
} from "@/lib/data/push-field-mappings-client";

/** Stored shape for platform "emailbison_people" in push_field_mappings
 * (ticket #114) — same key push-to-emailbison-button.tsx (the workspace
 * button) saves under, so a client's mapping is shared/consistent across
 * both the "Add to EmailBison" and "Add to Campaign" buttons rather than
 * drifting into two independent mappings. */
interface SavedEmailBisonFieldMapping {
  standardFields: EmailBisonStandardFieldMapping;
}

/** A People-table column bindable by a custom-variable row — every real
 * column of the resolved Person record, including the linked company's real
 * columns (lib/emailbison/lead-payload.ts's KNOWN_RECORD_FIELDS), not just
 * the original 18. Enrichment/virtual columns are offered separately, from
 * the `virtualColumns` prop. Identical to push-to-emailbison-button.tsx's
 * list — kept in sync deliberately, since both buttons feed the same
 * EmailBison lead payload.
 *
 * Ground-truth audit (2026-08-15) against the live `people` (36 cols) and
 * `companies` (39 cols) tables found this dropdown was missing every one of
 * the linked company's fields (the reported bug: no way to bind "Employees" —
 * companyEmployeeCount — even though the backend already resolves it) plus
 * five more person-own columns. Excluded on purpose: `id`/`company_id`
 * (PK/FK); `pushed_to_emailbison[_at]`/`pushed_to_ghl[_at]` (internal
 * push-tracking — circular to send back into EmailBison itself);
 * `custom_data` (its keys are already offered separately via the
 * enrichment-fields mechanism); `country_id`/`industry_id` (FK-like,
 * duplicate the already-exposed country/companyIndustry labels);
 * `source_tokens`/`niche_tokens` (raw arrays duplicating the already-exposed
 * sourceId/companyNiche); `job_title` (already exposed as `title`); and
 * `employee_count`/`company_linkedin_url` — confirmed via a live-data probe
 * to be exact synced mirrors of the linked company's own employee_count/
 * linkedin_url, already exposed below as companyEmployeeCount/
 * companyLinkedinUrl. "Company " is prefixed on the company* labels that
 * would otherwise collide with the person's own bare City/State/Country
 * labels above. */
const BINDABLE_RECORD_COLUMNS: { key: string; label: string }[] = [
  { key: "firstName", label: "First name" },
  { key: "lastName", label: "Last name" },
  { key: "email", label: "Email" },
  { key: "phone", label: "Phone" },
  { key: "companyName", label: "Company name (raw)" },
  { key: "brandName", label: "Cleaned brand name" },
  { key: "title", label: "Title" },
  { key: "website", label: "Website (domain)" },
  { key: "city", label: "City" },
  { key: "state", label: "State" },
  { key: "country", label: "Country" },
  { key: "fullName", label: "Full name" },
  { key: "linkedinUrl", label: "LinkedIn URL" },
  { key: "linkedinUsername", label: "LinkedIn username" },
  { key: "phoneType", label: "Phone type" },
  { key: "phoneStatus", label: "Phone status" },
  { key: "emailStatus", label: "Email status" },
  { key: "sourceId", label: "Source ID" },
  { key: "tags", label: "Tags" },
  { key: "emailVerifiedAt", label: "Email verified at" },
  { key: "phoneVerifiedAt", label: "Phone verified at" },
  { key: "lastUpdated", label: "Last updated" },
  { key: "createdAt", label: "Created at" },
  // Linked company's real columns (company* namespace) — previously entirely
  // absent from this dropdown despite being fully resolved on the backend.
  { key: "companyCity", label: "Company city" },
  { key: "companyState", label: "Company state" },
  { key: "companyCountry", label: "Company country" },
  { key: "companyIndustry", label: "Industry" },
  { key: "companyEmployeeCount", label: "Employees" },
  { key: "companyWebsiteUrl", label: "Website URL" },
  { key: "companyLinkedinUrl", label: "Company LinkedIn" },
  { key: "companyDomain", label: "Domain" },
  { key: "companyPhone", label: "Company phone" },
  { key: "companyPhoneType", label: "Company phone type" },
  { key: "companyPhoneStatus", label: "Company phone status" },
  { key: "companyEmail", label: "Company email" },
  { key: "companyEmailStatus", label: "Company email status" },
  { key: "companyEmailVerifiedAt", label: "Company email verified at" },
  { key: "companyPhoneVerifiedAt", label: "Company phone verified at" },
  { key: "companyNiche", label: "Niche" },
  { key: "companyQualityTier", label: "Quality tier" },
  { key: "companyClient", label: "Client" },
  { key: "companySource", label: "Source" },
  { key: "companyDescription", label: "Description" },
  { key: "companyFoundedYear", label: "Founded year" },
  { key: "companyRevenue", label: "Revenue" },
  { key: "companyDomainStatus", label: "Domain status" },
  { key: "companyMxProvider", label: "MX provider" },
  { key: "companySecurityGateway", label: "Security gateway" },
  { key: "companyKeywords", label: "Keywords" },
  { key: "companyTechnologies", label: "Technologies" },
  { key: "companyTags", label: "Company tags" },
  { key: "companyCreatedAt", label: "Company created at" },
  { key: "companyLastUpdated", label: "Company last updated" },
];

/** Standard-field keys, in the same order the mapping table renders them —
 * used only to normalize a saved mapping field-by-field on load (below), not
 * as a source of truth for the table itself (that's
 * StandardFieldMappingTable's own STANDARD_FIELD_ROWS). */
const STANDARD_FIELD_KEYS: (keyof EmailBisonStandardFieldMapping)[] = [
  "companyName",
  "firstName",
  "lastName",
  "email",
  "title",
];

/** A saved mapping (ticket #114) may still be shaped like the pre-free-source
 * include/skip + 3-way companyName enum — normalize every field through
 * normalizeFieldSource so an old saved mapping renders correctly in the new
 * dropdown-per-field table instead of showing a stale/invalid option. */
function normalizeSavedMapping(mapping: EmailBisonStandardFieldMapping): EmailBisonStandardFieldMapping {
  const result = {} as EmailBisonStandardFieldMapping;
  for (const key of STANDARD_FIELD_KEYS) {
    result[key] = normalizeFieldSource(key, mapping[key]);
  }
  return result;
}

interface CustomVariableRow {
  id: number;
  name: string;
  source: "literal" | "column";
  value: string;
  columnKey: string;
}

let rowIdCounter = 0;
function newRow(): CustomVariableRow {
  rowIdCounter++;
  return { id: rowIdCounter, name: "", source: "literal", value: "", columnKey: "" };
}

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

/** One sequence-step row in the create-campaign form (issue #94/#101),
 * camelCase mirror of lib/emailbison/client.ts's EmailBisonSequenceStepInput
 * plus a local `key` for React list identity independent of array index.
 * `variants` always has at least one entry — index 0 is the base ("A")
 * content, the rest are extra split test variants. */
interface SequenceStepForm {
  key: string;
  waitInDays: string;
  variants: StepVariantForm[];
}

function newSequenceStep(): SequenceStepForm {
  return {
    key: Math.random().toString(36).slice(2),
    waitInDays: "1",
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
    // "UTC"/"Etc/UTC"/"GMT" are all rejected 422 by EmailBison's live API
    // ("The selected timezone is invalid.") — default to a real IANA zone
    // confirmed working live (issue #103).
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
type Step = "picker" | "campaign" | "options" | "confirm" | "launch-confirm";

/** "Add to Campaign", the second EmailBison push action (ADR 0003, issue
 * #63) — attaches the current filtered People to a live-fetched campaign.
 * Any person missing a prior EmailBison lead id is silently upserted first
 * (runEmailBisonAddToCampaign, ticket #59); this button never needs "Add to
 * EmailBison" to have run first.
 *
 * The `options` step (mapping/custom-variables parity with the workspace
 * button, ticket #128) collects the same existing-lead-behavior,
 * standard-field-mapping, and custom-variables inputs push-to-
 * emailbison-button.tsx does, applied only to whichever candidates the
 * add-to-workspace fallback above actually has to upsert — runEmailBison
 * AddToCampaign (lib/emailbison/push-to-emailbison.ts) already forwards
 * these through to that fallback, so this step is purely a UI/request-body
 * addition. */
export function PushToEmailBisonCampaignButton({
  paramsStr,
  total,
  virtualColumns = [],
  onDone,
}: {
  paramsStr: string;
  total: number;
  /** Active virtual/enrichment columns on the current People view — offered
   * as bind targets for a column-bound custom-variable row and the
   * standard-field mapping table, alongside the standard People-table
   * fields in BINDABLE_RECORD_COLUMNS. Same prop push-to-emailbison-button.tsx
   * takes. */
  virtualColumns?: ActiveVirtualColumn[];
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
  const [createCampaignError, setCreateCampaignError] = useState<string | null>(null);
  const [createCampaignBusy, setCreateCampaignBusy] = useState(false);

  // Options step (ticket #128) — field-mapping/custom-variables parity with
  // push-to-emailbison-button.tsx. See that file's equivalent state for the
  // full "why" on each of these.
  const [existingLeadBehavior, setExistingLeadBehavior] = useState<"patch" | "put">("patch");
  const [rows, setRows] = useState<CustomVariableRow[]>([]);

  const [referenceVariables, setReferenceVariables] = useState<EmailBisonCustomVariable[] | null>(null);
  const [referenceError, setReferenceError] = useState<string | null>(null);

  const [enrichmentFields, setEnrichmentFields] = useState<EnrichmentField[]>([]);

  const [standardFieldMapping, setStandardFieldMapping] = useState<EmailBisonStandardFieldMapping | null>(
    null
  );
  const [standardFieldMappingError, setStandardFieldMappingError] = useState<string | null>(null);
  // In-flight guard for the campaign → options transition: keeps a re-click
  // from re-firing the field-mapping endpoints while they're loading.
  const [optionsLoading, setOptionsLoading] = useState(false);

  // Pre-flight "already in another campaign" check on the confirm step —
  // catches the gap reported live (351 leads silently failed, no warning
  // until Push Activity refreshed minutes later): ask before pushing instead
  // of only surfacing the rejection after the fact.
  const [conflictStatus, setConflictStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [conflictResult, setConflictResult] = useState<{ totalMatched: number; conflicting: number } | null>(
    null
  );
  const [conflictError, setConflictError] = useState<string | null>(null);

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
    setCreateCampaignBusy(false);
    setExistingLeadBehavior("patch");
    setRows([]);
    setReferenceVariables(null);
    setReferenceError(null);
    setEnrichmentFields([]);
    setStandardFieldMapping(null);
    setStandardFieldMappingError(null);
    setOptionsLoading(false);
    setConflictStatus("idle");
    setConflictResult(null);
    setConflictError(null);
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

  // campaign → options (ticket #128). Mirrors push-to-emailbison-button.tsx's
  // handleContinueFromPicker: fires the default-mapping, saved-mapping,
  // reference-variables, and enrichment-fields fetches in parallel rather
  // than in series, for the same reason (issue: the workspace dialog took
  // 13-23s to open when these ran sequentially).
  async function handleConfirmCampaign() {
    if (!selectedCampaign || !selectedClient) return;
    if (optionsLoading) return;

    const client = selectedClient;
    setStep("options");
    setReferenceVariables(null);
    setReferenceError(null);
    setEnrichmentFields([]);
    setStandardFieldMapping(null);
    setStandardFieldMappingError(null);
    setOptionsLoading(true);

    const referencePromise = (async () => {
      try {
        const res = await fetch(`/api/clients/${client.id}/emailbison-custom-variables`);
        if (!res.ok) throw new Error("Failed to load existing custom variables");
        const data = (await res.json()) as { variables: EmailBisonCustomVariable[] };
        setReferenceVariables(data.variables);
      } catch (error) {
        setReferenceError((error as Error).message || "Failed to load existing custom variables.");
      }
    })();

    // Best-effort: the column dropdown just falls back to the standard +
    // active-virtual-column fields if this fails, so a fetch error here
    // isn't worth its own error banner.
    const enrichmentPromise = (async () => {
      try {
        const res = await fetch(`/api/people/enrichment-fields?${paramsStr}`);
        if (!res.ok) throw new Error(res.status.toString());
        const data = (await res.json()) as { fields: EnrichmentField[] };
        setEnrichmentFields(data.fields);
      } catch {
        setEnrichmentFields([]);
      }
    })();

    // Ticket #114/#128: a saved mapping for this (client, "emailbison_people")
    // pair — shared with the workspace button — overrides the pure
    // auto-mapping default. Best-effort: a fetch failure just leaves the
    // auto-mapping default in place, same as having no saved mapping.
    const savedPromise = fetchSavedPushFieldMapping<SavedEmailBisonFieldMapping>(
      client.id,
      "emailbison_people"
    ).catch(() => null);

    const mappingPromise = (async () => {
      let base: EmailBisonStandardFieldMapping;
      try {
        const res = await fetch(`/api/emailbison/default-field-mapping?entity=people&${paramsStr}`);
        if (!res.ok) throw new Error("Failed to load default field mapping");
        const data = (await res.json()) as { standardFields: EmailBisonStandardFieldMapping };
        base = data.standardFields;
      } catch (error) {
        setStandardFieldMappingError((error as Error).message || "Failed to load default field mapping.");
        return;
      }
      const saved = await savedPromise;
      setStandardFieldMapping(saved ? normalizeSavedMapping(saved.standardFields) : base);
    })();

    try {
      await Promise.all([referencePromise, enrichmentPromise, mappingPromise]);
    } finally {
      setOptionsLoading(false);
    }
  }

  function handleContinueFromOptions() {
    setStep("confirm");
    checkCampaignConflicts();
  }

  // Best-effort pre-flight check, kicked off as the confirm step opens: how
  // many of the about-to-be-pushed people already look attached to a
  // different campaign in this workspace (lib/emailbison/push-to-emailbison.ts's
  // checkPeopleCampaignConflicts — a proxy off our own platform_pushes.campaign_tag,
  // not a live EmailBison read). A fetch failure here just leaves the warning
  // off; it never blocks the push itself.
  async function checkCampaignConflicts() {
    if (!selectedClient || !selectedCampaign) return;
    setConflictStatus("loading");
    setConflictError(null);
    setConflictResult(null);
    try {
      const res = await fetch(
        `/api/emailbison/campaign-conflict-check?entity=people&clientId=${selectedClient.id}&campaignId=${selectedCampaign.id}&${paramsStr}`
      );
      if (!res.ok) throw new Error("Failed to check for existing campaign membership");
      const data = (await res.json()) as { totalMatched: number; conflicting: number };
      setConflictResult(data);
      setConflictStatus("done");
    } catch (error) {
      setConflictError((error as Error).message || "Failed to check for existing campaign membership.");
      setConflictStatus("error");
    }
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

  async function handleSubmitCreateCampaign() {
    if (!selectedClient || !createFormValid || createCampaignBusy) return;
    setCreateCampaignError(null);
    setCreateCampaignBusy(true);

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
          sequenceSteps: createForm.steps.map((step, index) => ({
            emailSubject: step.variants[0].emailSubject,
            emailBody: step.variants[0].emailBody,
            // EmailBison rejects wait_in_days < 1 for EVERY step (issue #104):
            // step 1 has no wait-days UI (meaningless for the first step), and
            // steps 2+ can still be left at 0/blank in the form. Clamp all
            // steps to at least 1 so a 0/empty/negative value can't 422 the
            // whole create.
            waitInDays: Math.max(1, Math.floor(Number(step.waitInDays)) || 1),
            threadReply: false,
            extraVariants: step.variants.slice(1).map((variant) => ({
              emailSubject: variant.emailSubject,
              emailBody: variant.emailBody,
            })),
          })),
          // Always create as a draft. Launching at create time fails because a
          // just-created campaign has zero leads and EmailBison rejects
          // launching an empty campaign — the launch decision moved to the
          // lead-push step (launchOnComplete in handleConfirm).
          launch: false,
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
    } catch (error) {
      setCreateCampaignError((error as Error).message || "Failed to create campaign.");
    } finally {
      setCreateCampaignBusy(false);
    }
  }

  function addRow() {
    setRows((prev) => [...prev, newRow()]);
  }

  function removeRow(id: number) {
    setRows((prev) => prev.filter((r) => r.id !== id));
  }

  function updateRow(id: number, patch: Partial<CustomVariableRow>) {
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, ...patch } : r)));
  }

  /** Adds a custom-variable row pre-filled with an existing workspace
   * variable's name so the user only has to pick its source, rather than
   * retyping the name. Sourced-from-column by default since that's the point
   * of clicking a known variable; a no-op if a row with that name already
   * exists, to avoid silent duplicates. */
  function addVariableFromReference(name: string) {
    setRows((prev) =>
      prev.some((r) => r.name.trim() === name)
        ? prev
        : [...prev, { ...newRow(), name, source: "column" }]
    );
  }

  // A custom-variable row is invalid if its name is blank, or it's bound to
  // "Column" but no column has actually been chosen — either would silently
  // get dropped by customVariablesForPush()'s filter, so gate Continue on it
  // instead of letting the row vanish without explanation (issue #86).
  const hasInvalidCustomVariableRow = rows.some(
    (r) => r.name.trim() === "" || (r.source === "column" && r.columnKey === "")
  );

  function customVariablesForPush(): EmailBisonCustomVariableEntry[] {
    return rows
      .filter(
        (r) => r.name.trim() !== "" && (r.source === "literal" ? r.value.trim() !== "" : r.columnKey !== "")
      )
      .map((r) =>
        r.source === "literal"
          ? { name: r.name.trim(), value: r.value }
          : { name: r.name.trim(), value: "", columnKey: r.columnKey }
      );
  }

  // Push button on the confirm step. A freshly created (or otherwise draft)
  // campaign hasn't been launched — route through the in-dialog launch-confirm
  // step so the user can opt into launching once these leads attach. Any
  // non-draft campaign pushes immediately, exactly as before.
  function handlePushClick() {
    if (selectedCampaign?.status === "draft") {
      setStep("launch-confirm");
      return;
    }
    handleConfirm(false);
  }

  async function handleConfirm(launchOnComplete: boolean) {
    if (!selectedClient || !selectedCampaign) return;

    setStatus("pushing");
    setPushLabel("Queuing…");

    // Ticket #114/#128: save the mapping actually being used as the new
    // starting point for the next push to this (client, "emailbison_people")
    // pair — same shared key push-to-emailbison-button.tsx saves under.
    // Fire-and-forget — never blocks or fails the push; only ever affects
    // future pushes. Skipped when null (e.g. the default-mapping fetch
    // failed) so a saved override isn't wiped by an unrelated fetch error.
    if (standardFieldMapping) {
      savePushFieldMapping(selectedClient.id, "emailbison_people", {
        standardFields: standardFieldMapping,
      } satisfies SavedEmailBisonFieldMapping).catch(() => {});
    }

    // Pushes now run as durable background jobs (issue #120): POST enqueues a
    // push_jobs row and returns immediately. Rather than block the dialog on
    // the run, we toast and close — live progress and the completion summary
    // live in the Push Activity panel (issue #122).
    try {
      const res = await fetch(`/api/emailbison/push?${paramsStr}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          entity: "people",
          action: "campaign",
          clientId: selectedClient.id,
          campaignId: selectedCampaign.id,
          parallel,
          launchOnComplete,
          existingLeadBehavior,
          customVariables: customVariablesForPush(),
          standardFieldMapping: standardFieldMapping ?? undefined,
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

  // Standard fields, then active virtual columns, then every other
  // enrichment (custom_data) key discovered on the current view — deduped by
  // key so a field that's both an active virtual column and in the
  // discovery sample isn't offered twice. Identical construction to
  // push-to-emailbison-button.tsx.
  const bindableColumnKeys = new Set(BINDABLE_RECORD_COLUMNS.map((c) => c.key));
  const bindableColumns = [...BINDABLE_RECORD_COLUMNS];
  for (const c of virtualColumns) {
    if (bindableColumnKeys.has(c.key)) continue;
    bindableColumnKeys.add(c.key);
    bindableColumns.push({ key: c.key, label: c.key });
  }
  for (const f of enrichmentFields) {
    if (bindableColumnKeys.has(f.key)) continue;
    bindableColumnKeys.add(f.key);
    bindableColumns.push({ key: f.key, label: f.key });
  }

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
                          onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
                          className="mt-1.5 w-full rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                          placeholder="Campaign name"
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
                            onChange={(e) => setCreateForm((f) => ({ ...f, startTime: e.target.value }))}
                            className="rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                          />
                          <span className="text-xs text-ink-mute">to</span>
                          <input
                            type="time"
                            value={createForm.endTime}
                            onChange={(e) => setCreateForm((f) => ({ ...f, endTime: e.target.value }))}
                            className="rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                          />
                          <select
                            value={createForm.timezone}
                            onChange={(e) => setCreateForm((f) => ({ ...f, timezone: e.target.value }))}
                            className="min-w-0 flex-1 rounded-md border border-rule bg-transparent px-2 py-1.5 text-xs text-ink"
                          >
                            <option value="America/New_York">America/New_York</option>
                            <option value="America/Chicago">America/Chicago</option>
                            <option value="America/Denver">America/Denver</option>
                            <option value="America/Los_Angeles">America/Los_Angeles</option>
                            <option value="Europe/London">Europe/London</option>
                          </select>
                        </div>
                      </div>
                    </div>

                    <div>
                      <p className="text-xs font-semibold text-ink">Sender emails</p>
                      <div className="mt-2">
                        {selectedClient ? (
                          <SenderEmailPicker
                            clientId={selectedClient.id}
                            selectedIds={createForm.senderEmailIds}
                            onChange={(senderEmailIds) => setCreateForm((f) => ({ ...f, senderEmailIds }))}
                          />
                        ) : null}
                      </div>
                    </div>

                    <div>
                      <p className="text-xs font-semibold text-ink">Sequence steps</p>
                      <div className="mt-2 flex flex-col gap-3">
                        {createForm.steps.map((step, index) => (
                          <div
                            key={step.key}
                            className="rounded-lg border border-rule bg-hover/40 p-3"
                          >
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <span className="text-xs font-semibold text-ink">Step {index + 1}</span>
                              <div className="flex items-center gap-3">
                                {index > 0 ? (
                                  <label className="flex items-center gap-1.5 text-xs text-ink-mute">
                                    Wait
                                    <input
                                      type="number"
                                      min={1}
                                      value={step.waitInDays}
                                      onChange={(e) => updateStep(step.key, { waitInDays: e.target.value })}
                                      className="w-14 rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                                    />
                                    days
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

            <div className="mt-5 flex justify-end gap-2">
              {creatingCampaign ? (
                <>
                  <button
                    type="button"
                    onClick={handleCancelCreateCampaign}
                    disabled={createCampaignBusy}
                    className="rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink transition-smooth hover:bg-hover focus-visible:ring-2 focus-visible:ring-stamp/50 disabled:opacity-50"
                  >
                    ← Back
                  </button>
                  <button
                    type="button"
                    onClick={handleSubmitCreateCampaign}
                    disabled={!createFormValid || createCampaignBusy}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                      createFormValid && !createCampaignBusy
                        ? "bg-stamp hover:opacity-90"
                        : "cursor-not-allowed bg-stamp/40"
                    )}
                  >
                    {createCampaignBusy ? (
                      <Loader2 size={12} className="animate-spin" />
                    ) : null}
                    Create campaign
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
                    disabled={!selectedCampaign || optionsLoading}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                      selectedCampaign && !optionsLoading
                        ? "bg-stamp hover:opacity-90"
                        : "bg-stamp/40 cursor-not-allowed"
                    )}
                  >
                    {optionsLoading ? "Loading…" : "Continue →"}
                  </button>
                </>
              )}
            </div>
          </AlertDialog.Content>
        ) : step === "options" ? (
          <AlertDialog.Content className="fixed top-[10%] left-1/2 z-50 max-h-[80vh] w-full max-w-lg -translate-x-1/2 overflow-y-auto rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="text-sm font-semibold text-ink">
              Lead behavior &amp; custom variables
            </AlertDialog.Title>
            <AlertDialog.Description asChild>
              <div className="mt-4 flex flex-col gap-5 text-sm text-ink-soft">
                <p className="text-xs text-ink-mute">
                  Only applies to people who aren&apos;t already EmailBison leads — they&apos;re
                  added to the workspace first, using these settings, before being attached to the
                  campaign.
                </p>

                <div>
                  <p className="text-xs font-medium text-ink">Existing lead behavior</p>
                  <p className="mt-1 text-xs text-ink-mute">
                    How to handle a person who already exists as a lead in this workspace.
                  </p>
                  <div className="mt-2 flex flex-col gap-1.5">
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="radio"
                        name="existing-lead-behavior"
                        checked={existingLeadBehavior === "patch"}
                        onChange={() => setExistingLeadBehavior("patch")}
                      />
                      <span className="text-ink">
                        Partial update{" "}
                        <span className="text-ink-mute">
                          — EmailBison merges these fields into the existing lead (default)
                        </span>
                      </span>
                    </label>
                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="radio"
                        name="existing-lead-behavior"
                        checked={existingLeadBehavior === "put"}
                        onChange={() => setExistingLeadBehavior("put")}
                      />
                      <span className="text-ink">
                        Full replace{" "}
                        <span className="text-ink-mute">
                          — EmailBison blanks out any field not included here
                        </span>
                      </span>
                    </label>
                  </div>
                </div>

                {standardFieldMappingError ? (
                  <p className="text-xs text-danger">{standardFieldMappingError}</p>
                ) : standardFieldMapping === null ? (
                  <p className="flex items-center gap-2 text-xs text-ink-soft">
                    <Loader2 size={12} className="animate-spin" />
                    Loading default field mapping…
                  </p>
                ) : (
                  <StandardFieldMappingTable
                    value={standardFieldMapping}
                    columns={bindableColumns}
                    onChange={setStandardFieldMapping}
                  />
                )}

                <div>
                  <div className="flex items-center justify-between">
                    <p className="text-xs font-medium text-ink">Custom variables</p>
                    <button
                      type="button"
                      onClick={addRow}
                      className="inline-flex items-center gap-1 rounded-md border border-rule px-2 py-1 text-xs font-medium text-ink transition-smooth hover:bg-hover"
                    >
                      <Plus size={12} /> Add variable
                    </button>
                  </div>
                  <p className="mt-1 text-xs text-ink-mute">
                    Each variable name is sent with either a literal value or a value bound to a
                    People-table column/virtual column for each pushed person.
                  </p>

                  {rows.length > 0 ? (
                    <div className="mt-3 flex flex-col gap-2">
                      {rows.map((row) => {
                        const nameInvalid = row.name.trim() === "";
                        const columnInvalid = row.source === "column" && row.columnKey === "";
                        return (
                          <div
                            key={row.id}
                            className={cn(
                              "flex items-center gap-2 rounded-md border p-2",
                              nameInvalid || columnInvalid ? "border-danger/60" : "border-rule"
                            )}
                          >
                            <input
                              type="text"
                              placeholder="Variable name"
                              value={row.name}
                              onChange={(e) => updateRow(row.id, { name: e.target.value })}
                              className={cn(
                                "w-28 rounded-md border bg-transparent px-2 py-1 text-xs text-ink",
                                nameInvalid ? "border-danger/60" : "border-rule"
                              )}
                            />
                            <select
                              value={row.source}
                              onChange={(e) =>
                                updateRow(row.id, { source: e.target.value as "literal" | "column" })
                              }
                              className="rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                            >
                              <option value="literal">Static value</option>
                              <option value="column">Column</option>
                            </select>
                            {row.source === "literal" ? (
                              <input
                                type="text"
                                placeholder="Value"
                                value={row.value}
                                onChange={(e) => updateRow(row.id, { value: e.target.value })}
                                className="flex-1 rounded-md border border-rule bg-transparent px-2 py-1 text-xs text-ink"
                              />
                            ) : (
                              <select
                                value={row.columnKey}
                                onChange={(e) => updateRow(row.id, { columnKey: e.target.value })}
                                className={cn(
                                  "flex-1 rounded-md border bg-transparent px-2 py-1 text-xs text-ink",
                                  columnInvalid ? "border-danger/60" : "border-rule"
                                )}
                              >
                                <option value="">Choose a column…</option>
                                {bindableColumns.map((col) => (
                                  <option key={col.key} value={col.key}>
                                    {col.label}
                                  </option>
                                ))}
                              </select>
                            )}
                            <button
                              type="button"
                              onClick={() => removeRow(row.id)}
                              aria-label="Remove variable"
                              className="text-ink-mute transition-smooth hover:text-danger"
                            >
                              <X size={14} />
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  {hasInvalidCustomVariableRow ? (
                    <p className="mt-2 text-xs text-danger">
                      Give every custom variable a name, and choose a column for any row set to
                      &quot;Column&quot;.
                    </p>
                  ) : null}
                </div>

                <div>
                  <p className="text-xs font-medium text-ink">
                    Existing workspace variables <span className="text-ink-mute">(reference only)</span>
                  </p>
                  <div className="mt-2 max-h-28 overflow-y-auto rounded-md border border-rule p-2">
                    {referenceError ? (
                      <p className="text-xs text-danger">{referenceError}</p>
                    ) : referenceVariables === null ? (
                      <p className="flex items-center gap-2 text-xs text-ink-soft">
                        <Loader2 size={12} className="animate-spin" />
                        Loading…
                      </p>
                    ) : referenceVariables.length === 0 ? (
                      <p className="text-xs text-ink-mute">No custom variables in this workspace yet.</p>
                    ) : (
                      <div className="flex flex-wrap gap-1.5">
                        {referenceVariables.map((v) => (
                          <button
                            key={v.id}
                            type="button"
                            onClick={() => addVariableFromReference(v.name)}
                            title={`Add "${v.name}" as a custom variable`}
                            aria-label={`Add "${v.name}" as a custom variable`}
                            className="cursor-pointer rounded-full border border-rule px-2 py-0.5 text-xs text-ink-soft transition-smooth hover:bg-hover hover:text-ink focus-visible:ring-2 focus-visible:ring-stamp/50"
                          >
                            + {v.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
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
                onClick={handleContinueFromOptions}
                disabled={hasInvalidCustomVariableRow}
                title={
                  hasInvalidCustomVariableRow
                    ? "Fix the incomplete custom variable row(s) before continuing"
                    : undefined
                }
                className={cn(
                  "rounded-md px-3 py-1.5 text-xs font-medium text-white transition-smooth focus-visible:ring-2 focus-visible:ring-stamp/50",
                  hasInvalidCustomVariableRow
                    ? "bg-stamp/40 cursor-not-allowed"
                    : "bg-stamp hover:opacity-90"
                )}
              >
                Continue →
              </button>
            </div>
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
              automatically. No quality filter is applied, this is exactly the currently
              filtered/selected set.
            </AlertDialog.Description>

            {conflictStatus === "loading" ? (
              <p className="mt-3 flex items-center gap-2 text-xs text-ink-soft">
                <Loader2 size={12} className="animate-spin" />
                Checking whether any of these are already in another campaign…
              </p>
            ) : conflictStatus === "error" ? (
              <p className="mt-3 text-xs text-ink-mute">{conflictError}</p>
            ) : conflictStatus === "done" && conflictResult && conflictResult.conflicting > 0 ? (
              <div className="mt-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-ink">
                <strong>{conflictResult.conflicting.toLocaleString("en-US")}</strong> of{" "}
                {conflictResult.totalMatched.toLocaleString("en-US")} already look active in a
                different campaign in this workspace. EmailBison won&apos;t add them to{" "}
                {selectedCampaign?.name} unless parallel sending is allowed for this push. Push
                them in anyway?
                <button
                  type="button"
                  onClick={() => setParallel(!parallel)}
                  className="mt-2 flex items-center gap-2 text-ink"
                >
                  <span
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-smooth",
                      parallel ? "border-stamp bg-stamp text-white" : "border-rule"
                    )}
                  >
                    {parallel ? <Check size={12} /> : null}
                  </span>
                  {parallel ? "Parallel sending allowed for this push" : "Yes, allow parallel sending for this push"}
                </button>
              </div>
            ) : null}

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
                onClick={handlePushClick}
                className="rounded-md bg-stamp px-3 py-1.5 text-xs font-medium text-white transition-smooth hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stamp/50"
              >
                Push {total.toLocaleString("en-US")}
              </button>
            </div>
          </AlertDialog.Content>
        ) : (
          <AlertDialog.Content className="fixed top-[26%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
            <AlertDialog.Title className="flex items-center gap-2 text-sm font-semibold text-ink">
              <Rocket size={14} className="text-stamp" />
              Launch {selectedCampaign?.name ? `"${selectedCampaign.name}"` : "campaign"}?
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
              This campaign isn&apos;t launched yet. Launch it automatically once these leads are
              added? (It won&apos;t launch if no leads attach.)
            </AlertDialog.Description>

            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => handleConfirm(false)}
                className="rounded-md border border-rule px-3 py-1.5 text-xs font-medium text-ink transition-smooth hover:bg-hover focus-visible:ring-2 focus-visible:ring-stamp/50"
              >
                Just add leads
              </button>
              <button
                type="button"
                onClick={() => handleConfirm(true)}
                className="inline-flex items-center gap-1.5 rounded-md bg-stamp px-3 py-1.5 text-xs font-medium text-white transition-smooth hover:opacity-90 focus-visible:ring-2 focus-visible:ring-stamp/50"
              >
                <Rocket size={12} />
                Add leads &amp; launch
              </button>
            </div>
          </AlertDialog.Content>
        )}
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
