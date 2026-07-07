import "server-only";

/** ClearoutPhone single-number (real-time) verification.
 * https://clearoutphone.io/ — the docs site is a JS SPA that doesn't reflect
 * the actual API, so this wrapper is built against a verified live response
 * shape rather than the published docs.
 *
 * Unlike MillionVerifier, there is no running credit-balance field anywhere
 * in the response (`billable_credits` is just the cost of this one call), so
 * there's nothing to surface as "N credits left" here. */
const API_URL = "https://api.clearoutphone.io/v1/phonenumber/validate";

export interface VerifyResult {
  /** The phone number that was verified (echoed back by the API). */
  phone: string;
  /** "valid" | "invalid" | possibly other values ClearoutPhone hasn't
   * documented — pass through raw rather than hard-failing on an unknown
   * status, since the set isn't confirmed closed. */
  status: string;
  /** "mobile" | "landline" | "voip" | "toll_free" | null. Null when
   * ClearoutPhone returns an empty string (e.g. for an invalid number). */
  lineType: string | null;
  carrier: string | null;
  location: string | null;
}

interface RawVerifyData {
  status?: string;
  line_type?: string;
  carrier?: string;
  location?: string;
}

interface RawVerifyResponse {
  status?: string;
  data?: RawVerifyData;
  error?: { code?: number; message?: string };
}

export interface VerifyDeps {
  fetchImpl?: typeof fetch;
  /** Override for tests; defaults to process.env.CLEAROUT_PHONE_API_TOKEN. */
  apiKey?: string;
}

/** Verify a single phone number. Throws on a missing key, a network failure,
 * or an API-level error (bad token) — callers should treat a throw as
 * "status unchanged, surface the message" rather than writing a result. The
 * API is tolerant of any input format (e164, dashes/parens, bare digits), so
 * no normalization is done here beyond trimming. */
export async function verifyPhone(
  phone: string,
  deps: VerifyDeps = {}
): Promise<VerifyResult> {
  const apiKey = deps.apiKey ?? process.env.CLEAROUT_PHONE_API_TOKEN;
  if (!apiKey) {
    throw new Error("CLEAROUT_PHONE_API_TOKEN is not set");
  }

  const trimmed = phone.trim();
  if (!trimmed) {
    throw new Error("No phone number to verify");
  }

  const fetchImpl = deps.fetchImpl ?? fetch;

  const resp = await fetchImpl(API_URL, {
    method: "POST",
    headers: {
      // Literal "Bearer:" with no space before the token — confirmed against
      // the live API, not a typo.
      Authorization: `Bearer:${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ number: trimmed }),
  });

  if (!resp.ok) {
    throw new Error(`ClearoutPhone returned HTTP ${resp.status}`);
  }

  const data = (await resp.json()) as RawVerifyResponse;

  if (data.error) {
    throw new Error(`ClearoutPhone: ${data.error.message ?? "unknown error"}`);
  }

  const status = data.data?.status?.trim();
  if (!status) {
    throw new Error("ClearoutPhone returned no status");
  }

  const lineType = data.data?.line_type?.trim();

  return {
    phone: trimmed,
    status,
    lineType: lineType ? lineType : null,
    carrier: data.data?.carrier ?? null,
    location: data.data?.location ?? null,
  };
}
