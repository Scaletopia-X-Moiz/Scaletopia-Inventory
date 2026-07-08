import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  getAllFilteredCompanies,
  invalidateCompaniesListCache,
  type CompanyListFilters,
} from "@/lib/data/companies";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_MODEL = "google/gemini-2.5-flash-lite";

/** How many "Clean Names" OpenRouter calls to run at once. This is a chat
 * completion, not a live SMTP/phone probe, so it can run much hotter than the
 * verify buttons — 20 keeps a large filtered view moving without hammering
 * OpenRouter hard enough to trip its own rate limits constantly. */
export const CLEAN_NAMES_CONCURRENCY = 20;

/** 429s get their own retry budget, separate from WEBHOOK_RETRIES (which
 * covers 5xx/network blips): concurrency fires 20 requests at once, so a
 * short burst tripping OpenRouter's rate limit is expected, not exceptional. A
 * single flat 250ms retry isn't enough to clear it — this backs off
 * exponentially (honoring `Retry-After` when OpenRouter sends one) instead of
 * lowering CLEAN_NAMES_CONCURRENCY, so the run doesn't get slower for the
 * common case of a request that never gets rate-limited. */
export const RATE_LIMIT_MAX_RETRIES = 5;
const RATE_LIMIT_BASE_DELAY_MS = 500;
export const RATE_LIMIT_MAX_DELAY_MS = 8_000;

const TRANSIENT_STATUSES = new Set([500, 502, 503, 504]);
const WEBHOOK_RETRIES = 1; // for transient/network errors, mirrors push-to-clay's naming
const FAILED_PREVIEW = 20;

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (!Number.isNaN(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(header);
  return Number.isNaN(dateMs) ? null : Math.max(0, dateMs - Date.now());
}

function rateLimitBackoffMs(attempt: number): number {
  const exp = Math.min(RATE_LIMIT_BASE_DELAY_MS * 2 ** attempt, RATE_LIMIT_MAX_DELAY_MS);
  return exp + Math.random() * 250; // jitter so a burst doesn't retry in lockstep
}

const PROMPT_TEMPLATE =
  "Extract the simplified brand name from this company: {{COMPANY_NAME}} with website {{WEBSITE}}. Use the company name as the primary source. Use the website domain as a secondary reference to confirm or clarify the brand name if the company name is unclear. CHECK THESE TWO CONDITIONS BEFORE APPLYING ANY RULES. CONDITION A ALL CAPS: Applies when the original company name is written entirely in ALL CAPS (every letter uppercase). FIRST check if it is a single word with no spaces — if so convert to Title Case: capitalize the first letter and make all remaining letters lowercase. Examples: PACKER becomes Packer. KREWE becomes Krewe. RVCA becomes Rvca. MUJI becomes Muji. MICHE becomes Miche. INTERMIX becomes Intermix. INDOCHINO becomes Indochino. If it has multiple words separated by spaces — extract ONLY the first word, convert the first letter to uppercase and all remaining letters to lower. The second word, third word, and all other words are completely discarded. Then apply the short-prefix check: if the extracted first word is 3 characters or fewer (such as Le, La, De, Du, El), keep the first TWO words instead and convert both to Title Case. Examples to follow exactly: KIKI DE MONTPARNASSE — first word Kiki has 4 chars — output is Kiki. ELIE TAHARI — first word Elie has 4 chars — output is Elie (not ELIE, not Elie Tahari). ALEX AND ANI — first word Alex has 4 chars — output is Alex (not Alex And Ani, not ALEX AND ANI). LE CHÂTEAU — first word Le has 2 chars which is 3 or fewer — keep both words — output is Le Château. If Condition A applies return the result immediately and skip everything below. CONDITION B LONG NAME: First remove any standalone legal suffixes from the end (inc, incorporated, llc, ltd, limited, corp, corporation, co, company, gmbh, srl, plc, pvt, private). Then check if the name appears to be a person's full name — a human first name followed by a connector (e.g. ola, van, von, del, di, de la) and a surname. If yes do NOT abbreviate — keep the full name as-is. Examples: Oscar de la Renta stays Oscar de la Renta. Ralph Lauren stays Ralph Lauren. Carolina Herrera stays Carolina Herrera. Then count the remaining words. If 4 or more words remain — FIRST check the domain: strip the TLD (.com, .co, .net, .org, .io, etc.) and any non-brand URL prefix (get, try, shop, drink, eat, my, use, hello, join, buy). If the resulting domain stem is meaningfully shorter than the full company name — fewer words or clearly abbreviated — use it as the brand name: uppercase all letters if the stem is 5 characters or fewer, otherwise convert to Title Case. If the domain stem is not meaningfully shorter, or spells out the full company name, fall back to building an acronym: use the first letter of each major word, skip only these minor words: of, in, at, for, and, or, but, a, an. Keep all other words including The at the start. Capitalize every letter of the result. Example: Better Fnacks Inc — remove Inc — 4 words remain — domain is bfys.com — strip .com → bfys — 5 or fewer characters → uppercase all letters → result BFYS. Example: The House of Cards in Karachi — no suffix — 6 words — domain spells full name — fall back to acronym — T from The, H from House, skip of, C from Cards, skip in, K from Karachi — result THCK. If Condition B applies return the result and skip everything below. IF NEITHER CONDITION APPLIES follow these rules in order. RULE 1: Remove legal suffixes when they appear as standalone tokens at the end — inc, incorporated, llc, ltd, limited, corp, corporation, co, company, gmbh, srl, plc, pvt, private. Also remove trailing punctuation or commas left behind. RULE 2: If the name contains a slash, dash separator, or plus sign separating two distinct names, keep only the first name before the separator. Examples: Follow Your Heart / Earth Island becomes Follow Your Heart. Mantova - Fine Italian Food becomes Mantova. RULE 3: if the name begins with The, remove it unless the brand is universally known with The as inseparable (e.g. The North Face). For most brands remove The. RULE 4: If the remaining name ends with an organizational or descriptive tail, remove that tail and keep the brand stem. Tails to remove: systems, engineering, products, industries, group, solutions, services, electric, manufacturing. RULE 5: If the remaining name ends with a generic product or service category word that is not part of the core brand identity, remove it. Category words include: cupcakes, pizza, burgers, coffee, bakery, restaurant, cafe, salon, fitness, cleaners, repairs, rentals, photography, consulting, agency, studios, clinic, pharmacy, dental, realty, logistics, supplies, furnishings, apparel, jewelry, eyewear, optical, collection, trading. Only remove these when the remaining name still clearly identifies the brand. If removing the word would leave nothing meaningful, keep the full name. RULE 6: If the company name is a long institutional or administrative name containing phrases like of [Parent Organization] or at [Institution] or for [Entity], convert the full name into an acronym using the first letter of each major word. Apply legal suffix removal before acronymizing. RULE 7: Keep the shortest clean name that still clearly represents the brand. Prefer a single word when the brand is clearly a single-word name. Do not invent, add, or replace words. CASING RULE: After applying all rules, if the final result is 2 to 5 characters and consists entirely of uppercase letters, it is an abbreviation — preserve all-caps exactly and do not convert to Title Case. If the result is a normal word or brand name, preserve the original casing from the input. OUTPUT: respond with ONLY the brandName value as a plain string. No JSON, no quotes, no explanation.";

function buildPrompt(companyName: string, website: string): string {
  return PROMPT_TEMPLATE.replace("{{COMPANY_NAME}}", companyName).replace(
    "{{WEBSITE}}",
    website
  );
}

export interface CleanNameDeps {
  fetchImpl?: typeof fetch;
  /** Override for tests; defaults to process.env.OPENROUTER_API_KEY. */
  apiKey?: string;
}

export interface CleanNamesProgress {
  phase: "resolving" | "cleaning" | "done";
  done: number;
  total: number;
  cleaned: number;
  errors: number;
}

export interface CleanNamesResult {
  /** Candidates needing a clean (post-skip). */
  total_matched: number;
  cleaned: number;
  /** Rows skipped because brand_name was already set. */
  skipped: number;
  errors: number;
  /** Company-name preview of failures, capped at FAILED_PREVIEW. */
  failed: string[];
}

export interface RunCleanNamesDeps extends CleanNameDeps {
  onProgress?: (p: CleanNamesProgress) => void;
}

interface OpenRouterResponse {
  choices?: { message?: { content?: string } }[];
}

/** Call OpenRouter (gemini-2.5-flash-lite) to simplify one company name into a
 * short brand name. Throws on a missing key, a hard non-retryable failure
 * status (e.g. 401/402/400), or an empty/malformed model response — callers
 * should treat a throw as "no brand name written for this row", not retry
 * further themselves (retries for 429/5xx already happened inside here). */
export async function cleanCompanyName(
  companyName: string,
  website: string,
  deps: CleanNameDeps = {}
): Promise<string> {
  const apiKey = deps.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set");
  }

  const fetchImpl = deps.fetchImpl ?? fetch;
  const body = {
    model: OPENROUTER_MODEL,
    messages: [{ role: "user", content: buildPrompt(companyName, website) }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "company_name_formatting",
        strict: true,
        schema: {
          type: "object",
          properties: {
            formattedCompanyName: {
              type: "string",
              description: "The cleaned, simplified brand name",
            },
          },
          required: ["formattedCompanyName"],
          additionalProperties: false,
        },
      },
    },
    plugins: [{ id: "response-healing" }],
  };

  let transientAttempt = 0;
  let rateLimitAttempt = 0;

  for (;;) {
    const resp = await fetchImpl(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    if (resp.ok) {
      const json = (await resp.json()) as OpenRouterResponse;
      const content = json.choices?.[0]?.message?.content;
      if (!content) {
        throw new Error("OpenRouter returned no brand name");
      }
      let parsed: { formattedCompanyName?: string };
      try {
        parsed = JSON.parse(content);
      } catch {
        throw new Error("OpenRouter returned no brand name");
      }
      const brandName = parsed.formattedCompanyName?.trim();
      if (!brandName) {
        throw new Error("OpenRouter returned no brand name");
      }
      return brandName;
    }

    if (resp.status === 429) {
      if (rateLimitAttempt >= RATE_LIMIT_MAX_RETRIES) {
        const text = await resp.text().catch(() => "");
        throw new Error(`OpenRouter returned HTTP 429${text ? `: ${text}` : ""}`);
      }
      const retryAfterMs = parseRetryAfterMs(resp.headers?.get?.("Retry-After") ?? null);
      // Clamp the honored `Retry-After` to RATE_LIMIT_MAX_DELAY_MS. This runs
      // inside a serverless invocation, so a hostile or misconfigured
      // OpenRouter response returning a far-future date (or a huge seconds
      // value) would otherwise block the whole run — and the user's SSE
      // progress stream — until `maxDuration` kills it. A null/negative parse
      // still falls through to the exponential backoff below.
      const delayMs =
        retryAfterMs != null
          ? Math.min(retryAfterMs, RATE_LIMIT_MAX_DELAY_MS)
          : rateLimitBackoffMs(rateLimitAttempt);
      await new Promise((r) => setTimeout(r, delayMs));
      rateLimitAttempt++;
      continue;
    }

    if (TRANSIENT_STATUSES.has(resp.status)) {
      if (transientAttempt >= WEBHOOK_RETRIES) {
        const text = await resp.text().catch(() => "");
        throw new Error(`OpenRouter returned HTTP ${resp.status}${text ? `: ${text}` : ""}`);
      }
      await new Promise((r) => setTimeout(r, 250));
      transientAttempt++;
      continue;
    }

    const text = await resp.text().catch(() => "");
    throw new Error(`OpenRouter returned HTTP ${resp.status}${text ? `: ${text}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Bulk (current filtered view)
// ---------------------------------------------------------------------------

interface CleanNameTarget {
  id: string;
  companyName: string;
  website: string;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

interface RawCleanNameRow {
  id: string;
  company_name: string | null;
  domain: string | null;
  website_url: string | null;
  brand_name: string | null;
}

/** Resolve the current filtered Companies view into clean-name targets: rows
 * with no brand_name yet and a non-empty company_name. Reuses the exact
 * filtered query the list/export use, so the run's set equals the on-screen
 * set. `website` prefers `domain` (bare host) over `website_url`. */
async function resolveTargets(
  filters: CompanyListFilters
): Promise<{ targets: CleanNameTarget[]; skipped: number }> {
  const rows = await getAllFilteredCompanies(filters);
  const ids = rows.map((r) => r.id);

  const targets: CleanNameTarget[] = [];
  let skipped = 0;

  for (const idChunk of chunk(ids, 500)) {
    const { data, error } = await supabaseAdmin
      .from("companies")
      .select("id,company_name,domain,website_url,brand_name")
      .in("id", idChunk);
    if (error) throw error;
    for (const row of (data ?? []) as RawCleanNameRow[]) {
      if (row.brand_name && row.brand_name.trim() !== "") {
        skipped++;
        continue;
      }
      const companyName = row.company_name?.trim();
      if (!companyName) continue;
      targets.push({
        id: row.id,
        companyName,
        website: row.domain ?? row.website_url ?? "",
      });
    }
  }

  return { targets, skipped };
}

/** Clean every brand-name-less company name in the current filtered
 * Companies view via OpenRouter. Companies that already have a brand_name are
 * skipped (not re-run); companies with no company_name to clean are silently
 * dropped from the candidate set. */
export async function runCompaniesCleanNames(
  filters: CompanyListFilters,
  deps: RunCleanNamesDeps = {}
): Promise<CleanNamesResult> {
  const onProgress = deps.onProgress;

  onProgress?.({ phase: "resolving", done: 0, total: 0, cleaned: 0, errors: 0 });

  const { targets, skipped } = await resolveTargets(filters);
  const total = targets.length;

  if (total === 0) {
    onProgress?.({ phase: "done", done: 0, total: 0, cleaned: 0, errors: 0 });
    return { total_matched: 0, cleaned: 0, skipped, errors: 0, failed: [] };
  }

  onProgress?.({ phase: "cleaning", done: 0, total, cleaned: 0, errors: 0 });

  let cleaned = 0;
  let errors = 0;
  let done = 0;
  const failed: string[] = [];

  for (const group of chunk(targets, CLEAN_NAMES_CONCURRENCY)) {
    const results = await Promise.allSettled(
      group.map(async (target) => {
        const brandName = await cleanCompanyName(target.companyName, target.website, deps);
        const { error } = await supabaseAdmin
          .from("companies")
          .update({ brand_name: brandName })
          .eq("id", target.id);
        if (error) throw error;
        return target;
      })
    );

    for (let i = 0; i < results.length; i++) {
      done++;
      const settled = results[i];
      if (settled.status === "fulfilled") {
        cleaned++;
      } else {
        errors++;
        if (failed.length < FAILED_PREVIEW) failed.push(group[i].companyName);
      }
    }

    onProgress?.({ phase: "cleaning", done, total, cleaned, errors });
  }

  onProgress?.({ phase: "done", done, total, cleaned, errors });

  if (cleaned > 0) invalidateCompaniesListCache();

  return { total_matched: total, cleaned, skipped, errors, failed };
}
