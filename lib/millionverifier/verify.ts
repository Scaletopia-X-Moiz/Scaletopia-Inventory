import "server-only";

/** MillionVerifier single-email (real-time) verification.
 * https://developer.millionverifier.com/#operation/single
 *
 * The `result` field it returns uses the exact same vocabulary already stored
 * in people.email_status / companies.email_status, so a verify is just an
 * overwrite of that column. The bulk *file* API is a separate flow; this is the
 * one-email-at-a-time endpoint the "Reverify" buttons use. */
const API_BASE = "https://api.millionverifier.com/api/v3/";

/** Seconds MillionVerifier waits for the destination mail server before giving
 * up and returning `unknown`. Their max is 60; 10 keeps the button snappy. */
const VERIFY_TIMEOUT_SECONDS = 10;

/** The full set of `result` values MillionVerifier can return. `ok`,
 * `catch_all`, `unknown` and `invalid` already have badges; `disposable` is
 * added here (and to the badge). */
export const VERIFY_STATUSES = new Set([
  "ok",
  "catch_all",
  "unknown",
  "invalid",
  "disposable",
]);

export interface VerifyResult {
  /** The email that was verified (echoed back by the API). */
  email: string;
  /** One of VERIFY_STATUSES — write straight into email_status. */
  status: string;
  /** Human-readable quality summary ("good" | "risky" | "bad"), or null. */
  quality: string | null;
  /** Credits remaining on the account after this call, or null if absent. */
  credits: number | null;
}

interface RawVerifyResponse {
  email?: string;
  result?: string;
  quality?: string;
  credits?: number;
  error?: string;
}

export interface VerifyDeps {
  fetchImpl?: typeof fetch;
  /** Override for tests; defaults to process.env.MILLIONVERIFIER_API_KEY. */
  apiKey?: string;
}

/** A company `email` column can hold several comma-separated addresses; only
 * the first is verified. Returns null when there's nothing to verify. */
export function firstEmail(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const first = raw.split(",")[0]?.trim();
  return first ? first : null;
}

/** Verify a single email address. Throws on a missing key, a network failure,
 * or an API-level error (bad key, out of credits) — callers should treat a
 * throw as "status unchanged, surface the message" rather than writing a
 * result. A successful call always resolves with a VERIFY_STATUSES status. */
export async function verifyEmail(
  email: string,
  deps: VerifyDeps = {}
): Promise<VerifyResult> {
  const apiKey = deps.apiKey ?? process.env.MILLIONVERIFIER_API_KEY;
  if (!apiKey) {
    throw new Error("MILLIONVERIFIER_API_KEY is not set");
  }

  const trimmed = email.trim();
  if (!trimmed) {
    throw new Error("No email address to verify");
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = new URL(API_BASE);
  url.searchParams.set("api", apiKey);
  url.searchParams.set("email", trimmed);
  url.searchParams.set("timeout", String(VERIFY_TIMEOUT_SECONDS));

  const resp = await fetchImpl(url.toString(), { method: "GET" });
  if (!resp.ok) {
    throw new Error(`MillionVerifier returned HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as RawVerifyResponse;

  // The API reports credit/key problems in an `error` field with HTTP 200.
  if (data.error && data.error.trim() !== "") {
    throw new Error(`MillionVerifier: ${data.error}`);
  }

  const status = data.result?.trim();
  if (!status || !VERIFY_STATUSES.has(status)) {
    throw new Error(`MillionVerifier returned an unexpected result: ${data.result ?? "none"}`);
  }

  return {
    email: data.email ?? trimmed,
    status,
    quality: data.quality ?? null,
    credits: typeof data.credits === "number" ? data.credits : null,
  };
}
