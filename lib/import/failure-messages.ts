/**
 * Turns the raw Postgres/PostgREST error strings attached to failed import
 * records (`_failure_reason` in lib/import/push.ts) into short, plain-English
 * messages a non-technical person can act on. Used by the import results
 * screen to summarize *why* a batch of records failed, instead of just
 * showing a failure count.
 */

const FRIENDLY_COLUMN_NAMES: Record<string, string> = {
  company_name: "Company Name",
  full_name: "Full Name",
  first_name: "First Name",
  last_name: "Last Name",
  domain: "Domain",
  linkedin_url: "LinkedIn URL",
  email: "Email",
  phone: "Phone",
  job_title: "Job Title",
  industry: "Industry",
  country: "Country",
};

function friendlyColumn(column: string): string {
  return FRIENDLY_COLUMN_NAMES[column] ?? column;
}

/** Converts one record's raw failure reason into a plain-English sentence. */
export function translateFailureReason(raw: string | undefined | null): string {
  if (!raw) return "This record couldn't be saved due to an unexpected error.";

  const notNullMatch = raw.match(/^23502:.*column "([^"]+)"/);
  if (notNullMatch) {
    return `Missing a required value for "${friendlyColumn(notNullMatch[1])}".`;
  }

  const uniqueMatch = raw.match(/^23505:/);
  if (uniqueMatch) {
    return "Duplicate record — a matching row already exists.";
  }

  const foreignKeyMatch = raw.match(/^23503:/);
  if (foreignKeyMatch) {
    return "Refers to a related record that doesn't exist.";
  }

  const invalidInputMatch = raw.match(/^22P02:/);
  if (invalidInputMatch) {
    return "One or more values were in an unexpected format.";
  }

  if (raw.includes("_import_error") || /^Import (was )?(stopped|interrupted)/i.test(raw)) {
    return "The import was interrupted before this record could be saved.";
  }

  return "This record couldn't be saved due to an unexpected error.";
}

export interface FailureSummaryEntry {
  message: string;
  count: number;
}

/**
 * Groups failed records by their plain-English reason and returns the
 * biggest groups first. Records without a captured reason (e.g. the `_import_error`
 * marker written when a push throws mid-run — see push.ts) are still counted.
 */
export function summarizeFailures(records: Record<string, unknown>[]): FailureSummaryEntry[] {
  const counts = new Map<string, number>();

  for (const record of records) {
    const raw =
      (record._failure_reason as string | undefined) ??
      (record._import_error as string | undefined) ??
      undefined;
    const message = translateFailureReason(raw);
    counts.set(message, (counts.get(message) ?? 0) + 1);
  }

  return Array.from(counts.entries())
    .map(([message, count]) => ({ message, count }))
    .sort((a, b) => b.count - a.count);
}
