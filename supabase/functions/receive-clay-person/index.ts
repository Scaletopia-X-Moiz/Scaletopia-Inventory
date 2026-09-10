import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

/**
 * receive-clay-person
 *
 * Receives a single enriched person row from Clay's HTTP API output step.
 * Matches the person's company by domain, then upserts the person into people.
 *
 * Dedup order (first hit wins):
 *   1. linkedin_username exact               (fast path; requires the column populated)
 *   2. linkedin_url slug match  <-- ADDED     (catches rows that have linkedin_url but a
 *                                             NULL linkedin_username, e.g. aiark imports —
 *                                             this is what stops duplicate people)
 *   3. email exact
 *   4. full_name within the same company     <-- ADDED, last-resort fallback only
 *
 * Reserved keys (standard columns, not merged into custom_data):
 *   domain, company_linkedin_url, campaign_id, first_name, last_name, full_name,
 *   email, phone, job_title, linkedin_url, city, state, country,
 *   email_status, phone_type, source, source_id, custom_data
 */

const RESERVED_PERSON_KEYS = new Set([
  "domain",
  "company_linkedin_url",
  "campaign_id",
  "first_name",
  "last_name",
  "full_name",
  "email",
  "phone",
  "job_title",
  "linkedin_url",
  "city",
  "state",
  "country",
  "email_status",
  "phone_type",
  "source",
  "source_id",
  "custom_data",
]);

function normalizeDomain(input: string | null | undefined): string | null {
  if (!input) return null;
  let d = String(input).trim().toLowerCase();
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/^www\./, "");
  d = d.split("/")[0];
  d = d.split("?")[0];
  return d || null;
}

/**
 * Extract canonical LinkedIn username from any URL format.
 *   https://www.linkedin.com/in/john-doe-12345/       → john-doe-12345
 *   linkedin.com/in/JohnDoe                            → johndoe
 *   https://in.linkedin.com/in/janedoe?utm=xyz        → janedoe
 *   http://uk.linkedin.com/pub/jane-smith/a/b/c       → jane-smith (pub format)
 */
function extractLinkedinUsername(url: string | null | undefined): string | null {
  if (!url) return null;
  let u = String(url).trim().toLowerCase();
  if (!u) return null;

  // Strip protocol
  u = u.replace(/^https?:\/\//, "");
  // Strip www. or country subdomain (e.g., in., uk., de.)
  u = u.replace(/^[a-z]{2,3}\./, "");
  u = u.replace(/^www\./, "");

  // Must be a linkedin.com URL
  if (!u.startsWith("linkedin.com/")) return null;

  // Strip trailing query/fragment
  u = u.split("?")[0].split("#")[0];

  // Match /in/{username} or /pub/{username}/...
  const inMatch = u.match(/linkedin\.com\/in\/([^/]+)/);
  if (inMatch) return inMatch[1];

  const pubMatch = u.match(/linkedin\.com\/pub\/([^/]+)/);
  if (pubMatch) return pubMatch[1];

  return null;
}

function canonicalLinkedinUrl(username: string): string {
  return `https://www.linkedin.com/in/${username}`;
}

/**
 * Extract canonical company slug from any LinkedIn company URL.
 */
function extractCompanyLinkedinSlug(url: string | null | undefined): string | null {
  if (!url) return null;
  let u = String(url).trim().toLowerCase();
  if (!u) return null;
  u = u.replace(/^https?:\/\//, "");
  u = u.replace(/^[a-z]{2,3}\./, "");
  u = u.replace(/^www\./, "");
  if (!u.startsWith("linkedin.com/")) return null;
  u = u.split("?")[0].split("#")[0];
  const m = u.match(/linkedin\.com\/company\/([^/]+)/);
  return m ? m[1] : null;
}

/** PostgREST `or`/`ilike` treats , ( ) % _ * specially. LinkedIn slugs are
 * normally [a-z0-9-], but guard anyway so a weird slug can't break the filter
 * or turn into an unintended wildcard. Returns null if nothing safe is left. */
function safeSlugForIlike(slug: string | null): string | null {
  if (!slug) return null;
  const cleaned = slug.replace(/[,()%_*]/g, "");
  return cleaned.length > 0 ? cleaned : null;
}

function emptyToNull(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === "" ? null : s;
}

function addTagIfMissing(tags: string[] | null | undefined, tag: string): string[] {
  const current = Array.isArray(tags) ? tags : [];
  if (current.includes(tag)) return current;
  return [...current, tag];
}

interface FoundPerson {
  id: string;
  tags: string[] | null;
  custom_data: Record<string, unknown> | null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "POST only" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const rawDomain = body.domain as string | undefined;
  const domain = normalizeDomain(rawDomain);

  const rawCompanyLinkedin = body.company_linkedin_url as string | undefined;
  const companyLinkedinSlug = extractCompanyLinkedinSlug(rawCompanyLinkedin);

  if (!domain && !companyLinkedinSlug) {
    return new Response(
      JSON.stringify({
        error: "Either 'domain' or 'company_linkedin_url' is required to link person to a company",
        received: { domain: rawDomain, company_linkedin_url: rawCompanyLinkedin },
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  const campaignId = body.campaign_id
    ? String(body.campaign_id).trim().toLowerCase()
    : null;

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  // 1. Find company by domain (preferred), fallback to company_linkedin_url slug
  let company:
    | {
        id: string;
        company_name: string | null;
        domain: string | null;
        tags: string[] | null;
        niche: string | null;
      }
    | null = null;
  let lookupMethod: "domain" | "linkedin" | null = null;

  if (domain) {
    const { data, error } = await supabase
      .from("companies")
      .select("id, company_name, domain, tags, niche")
      .eq("domain", domain)
      .maybeSingle();
    if (error) {
      return new Response(
        JSON.stringify({
          error: "Company lookup by domain failed",
          details: error.message,
          domain,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    if (data) {
      company = data;
      lookupMethod = "domain";
    }
  }

  if (!company && companyLinkedinSlug) {
    const { data, error } = await supabase
      .from("companies")
      .select("id, company_name, domain, tags, niche")
      .ilike("linkedin_url", `%/company/${companyLinkedinSlug}%`)
      .limit(1)
      .maybeSingle();
    if (error) {
      return new Response(
        JSON.stringify({
          error: "Company lookup by linkedin_url failed",
          details: error.message,
          company_linkedin_slug: companyLinkedinSlug,
        }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    if (data) {
      company = data;
      lookupMethod = "linkedin";
    }
  }

  if (!company) {
    return new Response(
      JSON.stringify({
        error: "No company found by domain or company_linkedin_url",
        domain,
        company_linkedin_slug: companyLinkedinSlug,
        hint: "Company must exist in Supabase before a person can be linked to it",
      }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    );
  }

  // 2. Extract standard person fields
  const first_name = emptyToNull(body.first_name);
  const last_name = emptyToNull(body.last_name);
  const full_name =
    emptyToNull(body.full_name) ||
    [first_name, last_name].filter(Boolean).join(" ") ||
    null;
  const email = emptyToNull(body.email)?.toLowerCase() || null;
  const phone = emptyToNull(body.phone);
  const job_title = emptyToNull(body.job_title);

  // Extract LinkedIn username and normalize URL
  const rawLinkedinUrl = emptyToNull(body.linkedin_url);
  const linkedin_username = extractLinkedinUsername(rawLinkedinUrl);
  const linkedin_url = linkedin_username
    ? canonicalLinkedinUrl(linkedin_username)
    : rawLinkedinUrl;

  const city = emptyToNull(body.city);
  const state = emptyToNull(body.state);
  const country = emptyToNull(body.country);
  const email_status = emptyToNull(body.email_status);
  const phone_type = emptyToNull(body.phone_type);
  const source = emptyToNull(body.source) || "clay";
  const source_id = emptyToNull(body.source_id);

  // 3. Build incoming custom_data from non-reserved keys
  const existingCustomBlock = (body.custom_data as Record<string, unknown>) || {};
  const flatCustom: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (!RESERVED_PERSON_KEYS.has(key)) {
      flatCustom[key] = value;
    }
  }
  const incomingCustom = {
    ...flatCustom,
    ...existingCustomBlock,
  };

  // 4. Need at least one identifier
  if (!linkedin_username && !email && !full_name) {
    return new Response(
      JSON.stringify({
        error: "Person must have at least one of: linkedin_url, email, or full_name",
      }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // 5. Dedup lookup. Order matters — first match wins.
  //    The critical addition vs. the original is step 5b: matching by the
  //    linkedin_url SLUG. aiark-imported people have linkedin_url populated but
  //    linkedin_username NULL, so the old linkedin_username-only lookup never
  //    found them and every Clay push INSERTed a duplicate. Matching the URL
  //    slug (which every aiark row has) closes that gap for existing AND future
  //    imports without any backfill. When we then UPDATE, we also set
  //    linkedin_username on the matched row, so it self-heals onto the fast path.
  let existingPersonId: string | null = null;
  let existingTags: string[] = [];
  let existingCustomData: Record<string, unknown> = {};
  let matchMethod: "linkedin_username" | "linkedin_url" | "email" | "full_name" | null = null;

  function applyFound(found: FoundPerson, method: typeof matchMethod) {
    existingPersonId = found.id;
    existingTags = (found.tags as string[]) || [];
    existingCustomData = (found.custom_data as Record<string, unknown>) || {};
    matchMethod = method;
  }

  // 5a. linkedin_username exact (fast path)
  if (linkedin_username) {
    const { data: found, error: findErr } = await supabase
      .from("people")
      .select("id, tags, custom_data")
      .eq("linkedin_username", linkedin_username)
      .maybeSingle();
    if (findErr) {
      return new Response(
        JSON.stringify({ error: "Person lookup by linkedin_username failed", details: findErr.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    if (found) applyFound(found, "linkedin_username");
  }

  // 5b. linkedin_url slug match (catches rows with NULL linkedin_username, e.g. aiark)
  if (!existingPersonId) {
    const slug = safeSlugForIlike(linkedin_username);
    if (slug) {
      const { data: found, error: findErr } = await supabase
        .from("people")
        .select("id, tags, custom_data")
        .or(`linkedin_url.ilike.%/in/${slug}%,linkedin_url.ilike.%/pub/${slug}%`)
        .limit(1)
        .maybeSingle();
      if (findErr) {
        return new Response(
          JSON.stringify({ error: "Person lookup by linkedin_url failed", details: findErr.message }),
          { status: 500, headers: { "Content-Type": "application/json" } }
        );
      }
      if (found) applyFound(found, "linkedin_url");
    }
  }

  // 5c. email exact
  if (!existingPersonId && email) {
    const { data: found, error: findErr } = await supabase
      .from("people")
      .select("id, tags, custom_data")
      .eq("email", email)
      .maybeSingle();
    if (findErr) {
      return new Response(
        JSON.stringify({ error: "Person lookup by email failed", details: findErr.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    if (found) applyFound(found, "email");
  }

  // 5d. full_name within the SAME company — last-resort fallback only.
  //     Scoped to company_id to keep common names (many "John Smith") from
  //     colliding across the table. This is deliberately an exact,
  //     case-insensitive match: it will NOT reconcile a swapped-order name
  //     ("Lorena Haliti" vs "Haliti Lorena"), because a fuzzy name match across
  //     18k+ rows is a false-positive hazard. linkedin_url (5b) is the reliable
  //     key; treat this only as a safety net for records that truly have no
  //     LinkedIn and no email.
  if (!existingPersonId && full_name) {
    const { data: found, error: findErr } = await supabase
      .from("people")
      .select("id, tags, custom_data")
      .eq("company_id", company.id)
      .ilike("full_name", full_name.trim())
      .limit(1)
      .maybeSingle();
    if (findErr) {
      return new Response(
        JSON.stringify({ error: "Person lookup by full_name failed", details: findErr.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
    if (found) applyFound(found, "full_name");
  }

  // 6. Compute updated tags (existing person tags ∪ company tags ∪ campaign tag)
  const companyTags = Array.isArray(company.tags) ? company.tags : [];
  let updatedTags = Array.from(new Set([...existingTags, ...companyTags]));
  if (campaignId) {
    updatedTags = addTagIfMissing(updatedTags, `campaign:${campaignId}`);
  }

  // Resolve the niche for niche_tokens (the clean list the People Niche facet
  // counts — the raw tags above mix client/niche/date and are NOT what the
  // facet reads). Prefer the company's dedicated `niche` column; fall back to
  // element [1] of the company's [client, niche, date] tag tuple for companies
  // whose niche column was never populated. null => leave niche_tokens alone.
  const resolvedNiche = company.niche || (companyTags.length > 1 ? companyTags[1] : null);

  // 7. Insert or update
  if (existingPersonId) {
    // Partial update — only set fields that were actually provided
    const updateRow: Record<string, unknown> = {
      last_updated: new Date().toISOString(),
    };
    // Identity fields (name) are NEVER overwritten on an existing person. The
    // enrichment round-trip is not the source of truth for names, and Clay's
    // "Full Name" is often stored last-first ("Haliti Lorena"), which would
    // corrupt the correct stored name. Names are only set on INSERT (new
    // person) below. To intentionally update a name, do it via the app, not
    // this callback.
    if (email !== null) updateRow.email = email;
    if (phone !== null) updateRow.phone = phone;
    if (job_title !== null) updateRow.job_title = job_title;
    if (linkedin_url !== null) updateRow.linkedin_url = linkedin_url;
    if (linkedin_username !== null) updateRow.linkedin_username = linkedin_username;
    if (city !== null) updateRow.city = city;
    if (state !== null) updateRow.state = state;
    if (country !== null) updateRow.country = country;
    if (email_status !== null) updateRow.email_status = email_status;
    if (phone_type !== null) updateRow.phone_type = phone_type;
    if (source_id !== null) updateRow.source_id = source_id;

    // Merge custom_data (preserve existing keys not in incoming)
    if (Object.keys(incomingCustom).length > 0) {
      updateRow.custom_data = { ...existingCustomData, ...incomingCustom };
    }

    const tagsChanged =
      existingTags.length !== updatedTags.length ||
      !existingTags.every((t) => updatedTags.includes(t)) ||
      !updatedTags.every((t) => existingTags.includes(t));
    if (tagsChanged) {
      updateRow.tags = updatedTags;
    }

    // Self-heal niche_tokens onto the existing person from the resolved company
    // niche. Only set when we have one so a company without a niche never clears
    // a value the person already had.
    if (resolvedNiche) updateRow.niche_tokens = [resolvedNiche];

    const { error: updateErr } = await supabase
      .from("people")
      .update(updateRow)
      .eq("id", existingPersonId);

    if (updateErr) {
      return new Response(
        JSON.stringify({ error: "Person update failed", details: updateErr.message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({
        success: true,
        action: "updated",
        matched_by: matchMethod,
        person_id: existingPersonId,
        company_id: company.id,
        company_name: company.company_name,
        company_lookup_method: lookupMethod,
        domain: company.domain,
        linkedin_username,
        tags: updatedTags,
        fields_updated: Object.keys(updateRow).filter((k) => k !== "last_updated"),
      }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  }

  // INSERT new person
  const insertRow = {
    company_id: company.id,
    first_name,
    last_name,
    full_name,
    email,
    phone,
    job_title,
    linkedin_url,
    linkedin_username,
    city,
    state,
    country,
    company_name: company.company_name,
    domain: company.domain,
    source,
    source_id,
    email_status,
    phone_type,
    custom_data: incomingCustom,
    tags: updatedTags,
    // Clean niche list for the People Niche facet (see the update path above for
    // why the raw tags aren't enough), from the resolved company niche.
    niche_tokens: resolvedNiche ? [resolvedNiche] : [],
    last_updated: new Date().toISOString(),
  };

  const { data: inserted, error: insertErr } = await supabase
    .from("people")
    .insert(insertRow)
    .select("id")
    .single();

  if (insertErr) {
    return new Response(
      JSON.stringify({ error: "Person insert failed", details: insertErr.message }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }

  return new Response(
    JSON.stringify({
      success: true,
      action: "inserted",
      matched_by: null,
      person_id: inserted.id,
      company_id: company.id,
      company_name: company.company_name,
      company_lookup_method: lookupMethod,
      domain: company.domain,
      linkedin_username,
      tags: updatedTags,
      custom_data_keys: Object.keys(incomingCustom),
    }),
    { status: 200, headers: { "Content-Type": "application/json" } }
  );
});
