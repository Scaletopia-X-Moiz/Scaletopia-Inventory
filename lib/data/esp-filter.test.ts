import { describe, expect, it } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { getCompanies, getCompanyFilterOptions, toFilterOptionsRpcPayload as companyPayload } from "@/lib/data/companies";
import { getPeople, getPersonFilterOptions } from "@/lib/data/people";
import { includeOnly } from "@/lib/data/include-exclude";

// Ticket #25: ESP filter (companies.mx_provider). Every app-level number
// below is checked against an independent count built straight on the
// tables, so a mismatch between the PostgREST path, the SQL RPC path and the
// facet RPC shows up here. Runs against the live dataset like the other
// lib/data integration tests.

const ESPS = ["google", "microsoft", "other", "none"];

async function directCompanyCount(mx: string | null): Promise<number> {
  let q = supabaseAdmin.from("companies").select("id", { count: "exact", head: true });
  q = mx === null ? q.is("mx_provider", null) : q.eq("mx_provider", mx);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

async function directCompanyTotal(): Promise<number> {
  const { count, error } = await supabaseAdmin.from("companies").select("id", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

/** People whose linked company has this ESP, via an inner join. */
async function directPeopleCount(mx: string, emailStatus?: string): Promise<number> {
  let q = supabaseAdmin
    .from("people")
    .select("id, companies!inner(mx_provider)", { count: "exact", head: true })
    .eq("companies.mx_provider", mx);
  if (emailStatus) q = q.eq("email_status", emailStatus);
  const { count, error } = await q;
  if (error) throw error;
  return count ?? 0;
}

async function directPeopleTotal(): Promise<number> {
  const { count, error } = await supabaseAdmin.from("people").select("id", { count: "exact", head: true });
  if (error) throw error;
  return count ?? 0;
}

describe("Companies ESP filter", () => {
  it("facet counts equal a direct count per ESP value", async () => {
    const options = await getCompanyFilterOptions();
    for (const esp of ESPS) {
      const facet = options.mxProviders.find((o) => o.id === esp);
      expect(facet, esp).toBeDefined();
      expect(facet!.count, esp).toBe(await directCompanyCount(esp));
    }
    expect(options.mxProviders.find((o) => o.id === "google")?.label).toBe("Google");
  });

  it("include narrows the list to exactly that ESP", async () => {
    for (const esp of ESPS) {
      const result = await getCompanies({ mxProvider: includeOnly([esp]) }, 1, 5);
      expect(result.total, esp).toBe(await directCompanyCount(esp));
      for (const row of result.rows) expect(row.mxProvider).toBe(esp);
    }
  });

  it("exclude keeps companies with no ESP recorded", async () => {
    const total = await directCompanyTotal();
    const none = await directCompanyCount("none");
    const result = await getCompanies({ mxProvider: { include: [], exclude: ["none"] } }, 1, 5);
    expect(result.total).toBe(total - none);
  });

  it("the PostgREST path and the SQL RPC path agree (include and exclude)", async () => {
    for (const mxProvider of [includeOnly(["microsoft"]), { include: [], exclude: ["google", "none"] }]) {
      const list = await getCompanies({ mxProvider }, 1, 1);
      const { count, error } = await supabaseAdmin.rpc(
        "companies_matching_virtual_filters",
        { filters: companyPayload({ mxProvider }) },
        { count: "exact", head: true }
      );
      if (error) throw error;
      expect(list.total).toBe(count);
    }
  });

  it("the ESP facet is not narrowed by its own selection", async () => {
    const options = await getCompanyFilterOptions({ mxProvider: includeOnly(["google"]) });
    expect(options.mxProviders.find((o) => o.id === "microsoft")?.count).toBe(await directCompanyCount("microsoft"));
  });
});

describe("People ESP filter (via the linked company)", () => {
  it("facet counts equal a direct join count per ESP value", async () => {
    const options = await getPersonFilterOptions();
    for (const esp of ESPS) {
      const facet = options.mxProviders.find((o) => o.id === esp);
      expect(facet, esp).toBeDefined();
      expect(facet!.count, esp).toBe(await directPeopleCount(esp));
    }
  });

  it("include narrows the list to people at companies with that ESP", async () => {
    const result = await getPeople({ mxProvider: includeOnly(["none"]) }, 1, 5);
    expect(result.total).toBe(await directPeopleCount("none"));
    for (const row of result.rows) expect(row.mxProvider).toBe("none");
  });

  it("include and exclude of the same value partition the whole table", async () => {
    const [inc, exc, total] = await Promise.all([
      getPeople({ mxProvider: includeOnly(["none"]) }, 1, 1),
      getPeople({ mxProvider: { include: [], exclude: ["none"] } }, 1, 1),
      directPeopleTotal(),
    ]);
    expect(inc.total + exc.total).toBe(total);
  });

  it("combines with an existing filter (email status) with AND semantics", async () => {
    const options = await getPersonFilterOptions({ mxProvider: includeOnly(["none"]) });
    const status = options.emailStatuses[0]?.id;
    expect(status).toBeDefined();
    const result = await getPeople({ mxProvider: includeOnly(["none"]), emailStatus: includeOnly([status!]) }, 1, 1);
    expect(result.total).toBe(await directPeopleCount("none", status));
    expect(options.emailStatuses[0].count).toBe(result.total);
  });
});
