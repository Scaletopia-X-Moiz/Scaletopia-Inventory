"use client";

import { useEffect, useRef, useState } from "react";
import { AlertDialog } from "radix-ui";
import { Loader2, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import { showToast } from "@/components/shared/toast";
import { refreshOutcomeToast, type RefreshPlanMode, type RefreshResult } from "@/lib/ghl/refresh-outcome";
import { useRegisterDialogOpen } from "@/components/shared/dialog-stack";
import type { ClientOption } from "@/lib/data/clients";

/** Mirrors the server's own cap (docs/features/ghl-last-activity/multi-subaccount-contract.md,
 * Decision 4). Checked here only so the dialog can say what to do instead —
 * the endpoint rejects over-cap requests regardless. */
const MAX_TARGETED_IDS = 2000;

/** What the preview endpoint says this refresh would cost. `mode` is how the
 * population was arrived at, and it is the thing the dialog must not get
 * wrong — "the people your filters match" and "everything this sub-account
 * ever pushed" are different refreshes with very different bills. */
interface RefreshPreview {
  blocked: string | null;
  error?: string;
  mode?: RefreshPlanMode;
  personCount?: number;
  clientCount?: number;
  estimatedCalls?: number;
  /** `name` comes from the server, which reads EVERY client row — an inactive
   * sub-account (two of ours are) still holds people and still gets
   * refreshed, and naming it from the active-clients picker printed a bare
   * uuid. */
  clients?: { clientId: string; name: string | null; personCount: number; estimatedCalls: number }[];
}

/** How long the dialog waits before re-pricing after a narrowing change.
 *
 * Each preview resolves the whole filtered population server-side, and the
 * sub-account checkboxes are clicked in bursts — picking four of them fired
 * four full resolutions, three of which were obsolete before they returned.
 * Long enough to swallow a burst, short enough that the number appears while
 * the user is still looking at the list. */
const PREVIEW_DEBOUNCE_MS = 400;

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/** "Refresh activity": re-reads GHL message history for a set of people,
 * across **every** sub-account each of them was pushed to.
 *
 * Two scopes, and which one applies is decided by the table selection rather
 * than by a control in here — the user picks the scope by selecting rows, and
 * the dialog only states which one they picked:
 *
 * - rows selected → `{ kind: "ids" }`, exactly those people.
 * - nothing selected → `{ kind: "filters" }`, everyone matching the current
 *   view. The filter query string rides on the URL, as in PushToGhlButton.
 *
 * Every number shown here comes from the preview endpoint, which resolves the
 * same plan the confirm would enqueue. The dialog states no count of its own:
 * the table's filter count is NOT what a refresh costs (most matched people
 * have never been pushed to GHL, and a person pushed to three sub-accounts
 * costs three calls), and showing it here was a cost understated to the one
 * person who could still have said no.
 *
 * Sub-account narrowing is optional and off by default: omitting `clientIds`
 * means "wherever these people actually live", which is the honest default now
 * that a person can exist in several sub-accounts. Picking one by hand only
 * makes sense when the user wants to spend budget on one location.
 *
 * The response is one job per sub-account (Decision 1). Progress is polled in
 * the Push Activity panel, which already merges a job list by id — deliberately
 * no bespoke multi-job progress UI here (Decision 7). */
export function RefreshGhlActivityButton({
  paramsStr,
  selectedIds,
  clients,
  onDone,
}: {
  paramsStr: string;
  /** Person ids selected in the People table, in selection order. Empty means
   * the user is asking for the whole filtered set. */
  selectedIds: string[];
  /** EVERY sub-account, not just the active ones. A person pushed to a
   * sub-account that has since been deactivated is still refreshable and
   * still costs calls, so it has to be nameable and selectable here. Handed
   * down from the page, which already loads the list server-side. */
  clients: ClientOption[];
  onDone?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [narrowing, setNarrowing] = useState(false);
  const [narrowedIds, setNarrowedIds] = useState<string[]>([]);
  const [full, setFull] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<RefreshPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useRegisterDialogOpen(open);

  const targeted = selectedIds.length > 0;
  const overCap = selectedIds.length > MAX_TARGETED_IDS;
  const narrowedTo = narrowing && narrowedIds.length > 0 ? narrowedIds : null;

  /** Guards against an out-of-order preview: narrowing can be toggled faster
   * than a resolution of 25,000 people comes back, and the stale answer would
   * otherwise overwrite the fresh one with a cost the user is not about to
   * pay. */
  const previewSeq = useRef(0);
  const previewTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A pending preview outlives an unmount (the dialog can be closed mid-wait),
  // and firing it then would set state on a dead component.
  useEffect(() => () => { if (previewTimer.current) clearTimeout(previewTimer.current); }, []);

  function scopeBody() {
    return targeted ? { kind: "ids", personIds: selectedIds } : { kind: "filters" };
  }

  /** Resolves what the refresh would actually do. Driven from the handlers
   * (dialog open, narrowing changed) rather than an effect, as in
   * PushToGhlButton — the inputs only ever change in response to a click. */
  function schedulePreview(clientIds: string[] | null, delayMs = PREVIEW_DEBOUNCE_MS) {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    // Cleared now rather than when the request fires, so the dialog shows
    // "working it out" for the whole wait instead of a stale cost the user's
    // last click already invalidated.
    setPreview(null);
    setPreviewError(null);
    previewSeq.current++;
    previewTimer.current = setTimeout(() => {
      previewTimer.current = null;
      void loadPreview(clientIds);
    }, delayMs);
  }

  async function loadPreview(clientIds: string[] | null) {
    const seq = ++previewSeq.current;
    setPreview(null);
    setPreviewError(null);
    try {
      const res = await fetch(`/api/people/refresh-ghl-activity/preview?${paramsStr}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope: scopeBody(), clientIds: clientIds ?? undefined }),
      });
      const json = await res.json().catch(() => null);
      if (previewSeq.current !== seq) return;
      if (!res.ok) throw new Error(json?.error ?? "Failed to work out what this would refresh");
      setPreview(json as RefreshPreview);
    } catch (err) {
      if (previewSeq.current !== seq) return;
      setPreviewError((err as Error).message || "Failed to work out what this would refresh.");
    }
  }

  function handleClick() {
    setOpen(true);
    // No debounce on open: there is nothing to coalesce yet and the number is
    // the first thing the dialog has to say.
    if (!overCap) schedulePreview(null, 0);
  }

  function reset() {
    if (previewTimer.current) clearTimeout(previewTimer.current);
    previewTimer.current = null;
    previewSeq.current++; // discard any answer still in flight
    setOpen(false);
    setBusy(false);
    setNarrowing(false);
    setNarrowedIds([]);
    setFull(false);
    setPreview(null);
    setPreviewError(null);
  }

  /** Every narrowing change re-previews, because narrowing changes the cost:
   * it is the one control in this dialog that does. */
  function setNarrowingTo(checked: boolean) {
    setNarrowing(checked);
    if (!overCap) schedulePreview(checked && narrowedIds.length > 0 ? narrowedIds : null);
  }

  function toggleClient(id: string, checked: boolean) {
    const next = checked ? [...narrowedIds, id] : narrowedIds.filter((x) => x !== id);
    setNarrowedIds(next);
    // Debounced: picking several sub-accounts in a row is one decision, not
    // one full re-resolution of the population per checkbox.
    if (!overCap) schedulePreview(next.length > 0 ? next : null);
  }

  const blocked = preview?.blocked != null;
  const nothingToDo = preview != null && !blocked && (preview.personCount ?? 0) === 0;
  const canConfirm = !busy && !overCap && preview != null && !blocked && !nothingToDo;

  async function handleConfirm() {
    if (!canConfirm) return;
    setBusy(true);

    let result: RefreshResult;
    try {
      const res = await fetch(`/api/people/refresh-ghl-activity?${paramsStr}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          scope: scopeBody(),
          // Omitted entirely when not narrowing — the endpoint reads that as
          // "every sub-account these people were pushed to".
          clientIds: narrowedTo ?? undefined,
          full,
        }),
      });
      if (!res.ok) {
        const message = (await res.json().catch(() => null))?.error ?? "Failed to start refresh";
        throw new Error(message);
      }
      result = await res.json();
    } catch (err) {
      showToast((err as Error).message || "Failed to queue refresh — try again.", "error");
      setBusy(false);
      return;
    }

    showToast(...refreshOutcomeToast(result, clientName));
    onDone?.();
    reset();
  }

  /** Prefers the name the server sent with this plan, falls back to the
   * client list, and only then to the raw id. */
  const clientName = (id: string) =>
    preview?.clients?.find((c) => c.clientId === id)?.name ?? clients.find((c) => c.id === id)?.name ?? id;

  function renderCost() {
    if (overCap) return null;
    if (previewError) return <p className="text-xs text-red-500">{previewError}</p>;
    if (preview === null) {
      return (
        <div className="flex items-center gap-2 text-xs text-ink-soft">
          <Loader2 size={14} className="animate-spin" /> Working out what this would refresh…
        </div>
      );
    }
    if (preview.blocked) return <p className="text-xs text-red-500">{preview.error}</p>;

    const people = preview.personCount ?? 0;
    const subAccounts = preview.clientCount ?? 0;
    const calls = preview.estimatedCalls ?? 0;

    if (people === 0) {
      return (
        <p className="text-xs text-ink-soft">
          Nothing to refresh — none of these people have been pushed to a GHL sub-account.
        </p>
      );
    }

    // "N people" is only true when the plan names people. An `all_pushed`
    // plan sums each sub-account's pushed count, so two co-located
    // sub-accounts sharing 100 people read as 200 — nothing resolves the
    // overlap, because nothing resolved an id set. Say what the number is
    // instead of inflating a head count.
    const headline =
      preview.mode === "all_pushed"
        ? `${people.toLocaleString("en-US")} pushed ${plural(people, "contact", "contacts")}, counted once per sub-account,`
        : `${people.toLocaleString("en-US")} ${plural(people, "person", "people")}`;

    return (
      <div className="rounded-md border border-rule bg-card px-3 py-2 text-xs text-ink-soft">
        <p className="text-ink">
          <strong className="font-semibold">{headline}</strong>{" "}
          across{" "}
          <strong className="font-semibold">
            {subAccounts} {plural(subAccounts, "sub-account", "sub-accounts")}
          </strong>
          , costing{" "}
          <strong className="font-semibold">
            {preview.mode === "all_pushed" ? "up to " : "about "}
            {calls.toLocaleString("en-US")} GHL API {plural(calls, "call", "calls")}
          </strong>
          .
        </p>
        {preview.clients && preview.clients.length > 1 && (
          <ul className="mt-1.5 flex flex-col gap-0.5">
            {preview.clients.map((c) => (
              <li key={c.clientId}>
                {c.name ?? clientName(c.clientId)} — {c.personCount.toLocaleString("en-US")}{" "}
                {preview.mode === "all_pushed"
                  ? plural(c.personCount, "contact", "contacts")
                  : plural(c.personCount, "person", "people")}
                , ~{c.estimatedCalls.toLocaleString("en-US")}{" "}
                {plural(c.estimatedCalls, "call", "calls")}
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <AlertDialog.Root open={open} onOpenChange={(next) => !next && reset()}>
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        className={cn(
          "inline-flex items-center gap-2 rounded-md border border-rule px-3 py-1.5 text-xs font-medium transition-smooth",
          busy
            ? "cursor-not-allowed opacity-50"
            : "text-ink hover:bg-hover active:bg-hover/75 focus-visible:ring-2 focus-visible:ring-stamp/50"
        )}
        aria-label="Refresh GHL last activity"
      >
        {busy ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
        Refresh activity
      </button>

      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 z-40 bg-black/60" />
        <AlertDialog.Content className="fixed top-[24%] left-1/2 z-50 w-full max-w-md -translate-x-1/2 rounded-xl border border-rule bg-popover p-5 shadow-2xl outline-none">
          <AlertDialog.Title className="text-sm font-semibold text-ink">
            Refresh GHL last activity
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm text-ink-soft">
            {targeted ? (
              <>
                Re-reads GHL message history for the{" "}
                <strong className="font-semibold text-ink">
                  {selectedIds.length.toLocaleString("en-US")} selected{" "}
                  {plural(selectedIds.length, "person", "people")}
                </strong>
                , in every sub-account they were pushed to. People who were never pushed are
                skipped.
              </>
            ) : preview?.mode === "all_pushed" ? (
              <>
                Nothing is selected and no filters are applied, so this refreshes{" "}
                <strong className="font-semibold text-ink">
                  every contact the chosen sub-accounts have pushed to GHL
                </strong>
                . Select rows, or filter the table, to refresh less than that.
              </>
            ) : (
              <>
                Nothing is selected, so this refreshes{" "}
                <strong className="font-semibold text-ink">
                  the people matching the current filters that have been pushed to GHL
                </strong>
                , in every sub-account they were pushed to. The set is resolved now and fixed when
                you confirm — later changes to the filters, or to who matches them, don&apos;t
                change what the queued jobs do.
              </>
            )}
          </AlertDialog.Description>

          <div className="mt-4 flex flex-col gap-3">
            {overCap && (
              <p className="text-xs text-red-500">
                {selectedIds.length.toLocaleString("en-US")} people selected — the targeted refresh
                takes at most {MAX_TARGETED_IDS.toLocaleString("en-US")}. Clear the selection and
                refresh by filter instead, narrowing the filters until they match the set you want.
              </p>
            )}

            {renderCost()}

            <div className="flex flex-col gap-2">
              <label className="flex items-start gap-2 text-xs text-ink-soft">
                <input
                  type="checkbox"
                  checked={narrowing}
                  onChange={(e) => setNarrowingTo(e.target.checked)}
                  className="mt-0.5"
                />
                <span>
                  Only refresh specific sub-accounts. By default every sub-account these people
                  were pushed to is refreshed.
                </span>
              </label>
              {narrowing && (
                <div className="max-h-40 overflow-y-auto rounded-md border border-rule bg-card p-2">
                  {clients.map((client) => (
                    <label
                      key={client.id}
                      className="flex items-center gap-2 px-1 py-1 text-sm text-ink"
                    >
                      <input
                        type="checkbox"
                        checked={narrowedIds.includes(client.id)}
                        onChange={(e) => toggleClient(client.id, e.target.checked)}
                      />
                      <span>{client.name}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <label className="flex items-start gap-2 text-xs text-ink-soft">
              <input
                type="checkbox"
                checked={full}
                onChange={(e) => setFull(e.target.checked)}
                className="mt-0.5"
              />
              <span>
                Full re-read. Only affects a whole-sub-account refresh: that one normally re-reads
                just the conversations GHL says have moved (a couple of API calls), and ticking this
                re-reads every contact instead — one call each. A refresh of selected or filtered
                people always re-reads every person in it, so this changes nothing for those, and
                the estimate above already assumes it.
              </span>
            </label>
          </div>

          <div className="mt-5 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                className="rounded-md border border-rule px-3 py-1.5 text-xs text-ink-soft hover:bg-hover"
              >
                Cancel
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              onClick={handleConfirm}
              disabled={!canConfirm}
              className={cn(
                "inline-flex items-center gap-2 rounded-md px-3 py-1.5 text-xs font-medium",
                !canConfirm
                  ? "cursor-not-allowed bg-rule text-ink-mute"
                  : "bg-stamp text-white hover:bg-stamp/90"
              )}
            >
              {busy && <Loader2 size={14} className="animate-spin" />}
              {preview?.personCount
                ? preview.mode === "all_pushed"
                  ? `Refresh ${preview.personCount.toLocaleString("en-US")} ${plural(preview.personCount, "contact", "contacts")}`
                  : `Refresh ${preview.personCount.toLocaleString("en-US")} ${plural(preview.personCount, "person", "people")}`
                : "Refresh"}
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
