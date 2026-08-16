// Human labels for the `email_status` column, shared by the filter-chip label
// map (lib/data/people.ts / lib/data/companies.ts) and the badge
// (components/people/email-status-badge.tsx) so the two can't drift.
//
// Not a re-export of EMAIL_STATUSES/VERIFYING_STATUS from lib/icypeas/verify.ts
// on purpose: that module is `server-only`, but this file is bundled into
// client components (the badge is imported by components/shared/reverify-email.tsx,
// a client component). Keep the ids below in sync with EMAIL_STATUSES /
// VERIFYING_STATUS in lib/icypeas/verify.ts — that module remains the source
// of truth for what gets *written*; this one is only for *labeling*.
//
// Legacy MillionVerifier vocabulary is kept alongside so historical rows
// (never migrated, per the Icypeas cutover decision) still render a real
// label instead of falling back to the raw db value.
export const EMAIL_STATUS_LABELS: Record<string, string> = {
  // Legacy MillionVerifier vocabulary.
  ok: "OK",
  catch_all: "Catch-all",
  invalid: "Invalid",
  unknown: "Unknown",
  disposable: "Disposable",
  // Icypeas confidence-scale vocabulary (see lib/icypeas/verify.ts
  // EMAIL_STATUSES). No catch_all/disposable equivalent exists — Icypeas
  // can't produce either (research doc §5c).
  ultra_sure: "Ultra sure",
  very_sure: "Very sure",
  probable: "Probable",
  undeliverable: "Undeliverable",
  not_found: "Not found",
  // Transient marker written the moment a verification job is submitted,
  // before webhook/poll resolves it.
  verifying: "Verifying…",
};

/** Label for an `email_status` value, e.g. for filter chips and the badge.
 * Unmapped/legacy values fall back to the raw id rather than being hidden or
 * crashing, per the Icypeas cutover decision. */
export function emailStatusLabel(id: string): string {
  return EMAIL_STATUS_LABELS[id] ?? id;
}
