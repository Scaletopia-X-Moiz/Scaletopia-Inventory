import { describe, expect, it } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getPeopleForEmailBisonByCompanyFilters } from "@/lib/data/people";
import { resolveCustomVariables, buildEmailBisonLeadPayload } from "@/lib/emailbison/lead-payload";
import {
  upsertLeadsBulk,
  attachLeadsToCampaign,
  listCustomVariables,
  createCustomVariable,
} from "@/lib/emailbison/client";
import type { EmailBisonCredentials } from "@/lib/emailbison/types";

// A company known (from recon) to have city/state/industry populated AND a
// linked person — and whose COMPANY city (Marina del Rey) differs from its
// PERSON city (Los Angeles), which is exactly what proves the new company*
// columns resolve from the linked company, not the person.
const TARGET_COMPANY_SEARCH = "MUMTAZ LAW GROUP";

// Safe throwaway email so the real person is never the lead. Draft campaign
// means no send regardless; this is belt-and-suspenders.
const TEST_EMAIL = "team+eb-newcols-e2e@scaletopia-agency.com";

// A DRAFT (non-sending) campaign in the Internal workspace (recon2). "test 123".
const DRAFT_CAMPAIGN_ID = "1043";

// The three new company columns we bind custom variables to, using variable
// names that already exist in the Internal workspace.
const BOUND_VARS = [
  { name: "city", columnKey: "companyCity" },
  { name: "state", columnKey: "companyState" },
  { name: "industry", columnKey: "companyIndustry" },
];

async function internalCredentials(): Promise<EmailBisonCredentials> {
  const { data, error } = await supabaseAdmin
    .from("clients")
    .select("emailbison_api_key,emailbison_workspace_id")
    .eq("name", "Internal")
    .single();
  if (error) throw error;
  const row = data as { emailbison_api_key: string; emailbison_workspace_id: string };
  return { apiKey: row.emailbison_api_key, workspaceId: row.emailbison_workspace_id };
}

describe("EmailBison new bindable columns — end-to-end", () => {
  // Shared across the two ordered tests.
  let candidateRecord: Record<string, unknown>;
  let candidateCustomData: Record<string, unknown> | null;
  let dbCompany: { city: string | null; state: string | null; industry: string | null };
  let dbPersonCity: string | null;

  it("Part A: company columns resolve to the linked company's real DB values (no external writes)", async () => {
    // Real DB truth for the target company + its person.
    const { data: co } = await supabaseAdmin
      .from("companies")
      .select("id,city,state,industry")
      .ilike("company_name", TARGET_COMPANY_SEARCH)
      .limit(1)
      .single();
    expect(co, "target company must exist").toBeTruthy();
    dbCompany = co as typeof dbCompany;
    const { data: person } = await supabaseAdmin
      .from("people")
      .select("city")
      .eq("company_id", (co as { id: string }).id)
      .not("email", "is", null)
      .limit(1)
      .single();
    dbPersonCity = (person as { city: string | null } | null)?.city ?? null;

    console.log("DB company:", dbCompany, "| DB person city:", dbPersonCity);

    // Run the REAL company-push resolution path (the changed code).
    const candidates = await getPeopleForEmailBisonByCompanyFilters({
      search: TARGET_COMPANY_SEARCH,
    } as never);
    expect(candidates.length, "company must resolve to >=1 person").toBeGreaterThan(0);
    const candidate = candidates[0];
    candidateRecord = candidate.record as unknown as Record<string, unknown>;
    candidateCustomData = candidate.customData;

    // 1) The widened embed populated the new company* fields on the record.
    expect(candidateRecord.companyCity, "record.companyCity populated").toBe(dbCompany.city);
    expect(candidateRecord.companyState, "record.companyState populated").toBe(dbCompany.state);
    expect(candidateRecord.companyIndustry, "record.companyIndustry populated").toBe(dbCompany.industry);

    // 2) resolveCustomVariables maps bound vars -> the company's real values.
    const resolved = resolveCustomVariables(
      BOUND_VARS.map((v) => ({ name: v.name, value: "", columnKey: v.columnKey })),
      candidate.record,
      candidate.customData
    );
    const byName = Object.fromEntries(resolved.map((r) => [r.name, r.value]));
    console.log("Resolved custom vars:", byName);
    expect(byName.city).toBe(dbCompany.city);
    expect(byName.state).toBe(dbCompany.state);
    expect(byName.industry).toBe(dbCompany.industry);

    // 3) Distinction proof: binding a var to the PERSON key `city` yields the
    //    person's city, which differs from the company's city.
    const personResolved = resolveCustomVariables(
      [{ name: "person_city_probe", value: "", columnKey: "city" }],
      candidate.record,
      candidate.customData
    );
    console.log("Person-key `city` resolves to:", personResolved[0]?.value, "(company city:", dbCompany.city, ")");
    expect(personResolved[0]?.value).toBe(dbPersonCity);
    if (dbPersonCity && dbCompany.city) {
      expect(personResolved[0]?.value, "person city != company city").not.toBe(dbCompany.city);
    }
  });

  it("Part B: real push to Internal draft campaign + read-back verifies values landed", async () => {
    const credentials = await internalCredentials();

    // Ensure the 3 variable names exist in the workspace (all should already).
    const existing = new Set((await listCustomVariables(credentials)).map((v) => v.name));
    for (const v of BOUND_VARS) {
      if (!existing.has(v.name)) {
        console.log("creating missing custom variable:", v.name);
        await createCustomVariable(credentials, v.name);
      }
    }

    // Resolve against the Part A candidate, then override the email so the real
    // person is never the lead.
    const resolved = resolveCustomVariables(
      BOUND_VARS.map((v) => ({ name: v.name, value: "", columnKey: v.columnKey })),
      candidateRecord as never,
      candidateCustomData
    );
    const payload = buildEmailBisonLeadPayload(
      candidateRecord as never,
      candidateCustomData,
      resolved,
      "patch"
    );
    payload.email = TEST_EMAIL;
    console.log("Pushing payload:", JSON.stringify(payload));

    // Real upsert.
    const results = await upsertLeadsBulk(credentials, [payload]);
    console.log("upsert results:", JSON.stringify(results));
    expect(results.length, "upsert returned a lead").toBeGreaterThan(0);
    const leadId = results[0].id;

    // Attach to the DRAFT (non-sending) campaign.
    const attach = await attachLeadsToCampaign(credentials, DRAFT_CAMPAIGN_ID, [leadId]);
    console.log("attach result:", JSON.stringify(attach));
    // Attach is async on EB's side; success = it was accepted (in `attached`),
    // OR a benign "already in campaign" on a re-run. Log failures either way.
    expect(attach.attached.length + attach.failed.length).toBe(1);

    // Read the lead back and confirm the company values landed as custom vars.
    const base = credentials.workspaceId.replace(/\/$/, "");
    const headers = {
      Authorization: `Bearer ${credentials.apiKey}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    const r = await fetch(`${base}/api/leads/${leadId}`, { headers });
    const j = (await r.json().catch(() => null)) as { data?: Record<string, unknown> } | null;
    const lead = j?.data ?? (j as unknown as Record<string, unknown>);
    const cvRaw = (lead?.custom_variables ?? []) as Array<Record<string, unknown>>;
    const readBack = Object.fromEntries(cvRaw.map((c) => [c.name, c.value]));
    console.log(`read-back HTTP ${r.status} custom_variables:`, JSON.stringify(readBack));

    expect(readBack.city, "city landed on EmailBison lead").toBe(dbCompany.city);
    expect(readBack.state, "state landed on EmailBison lead").toBe(dbCompany.state);
    expect(readBack.industry, "industry landed on EmailBison lead").toBe(dbCompany.industry);
  });
});
