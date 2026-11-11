import { describe, expect, it } from "vitest";
import {
  isRetiredLocationName,
  namesCompatible,
  planClientSync,
  type BisonWorkspaceCandidate,
  type GhlLocationCandidate,
  type SyncDbClient,
  type SyncInputs,
} from "./location-sync-plan";

/** The Airtable -> clients sync only adds what GHL and EmailBison confirm, and
 * never rewrites a row that already exists (see location-sync-plan.ts). The
 * fixtures mirror the real drift found on 2026-11-12. */

function client(over: Partial<SyncDbClient> & Pick<SyncDbClient, "name" | "slug">): SyncDbClient {
  return {
    id: `id-${over.slug}`,
    ghlLocationId: null,
    hasGhlKey: false,
    hasEbKey: false,
    ebWorkspaceId: null,
    isActive: true,
    ...over,
  };
}

function ghl(over: Partial<GhlLocationCandidate> & Pick<GhlLocationCandidate, "airtableName" | "locationId">): GhlLocationCandidate {
  return {
    airtableRecordId: `rec-${over.locationId}`,
    status: "Active",
    apiKey: `pit-${over.locationId}`,
    liveName: `${over.airtableName} - Active`,
    bisonRecordId: null,
    ...over,
  };
}

function bison(
  over: Partial<BisonWorkspaceCandidate> & Pick<BisonWorkspaceCandidate, "airtableRecordId" | "airtableName">
): BisonWorkspaceCandidate {
  return { status: "Active", apiKey: `eb-${over.airtableRecordId}`, workspace: null, ...over };
}

function inputs(over: Partial<SyncInputs>): SyncInputs {
  return { clients: [], ghl: [], bison: [], liveNameByLocation: {}, ...over };
}

describe("namesCompatible / isRetiredLocationName", () => {
  it("allows qualifiers, spacing and GHL's status suffix", () => {
    expect(namesCompatible("Scaletopia (A2P verified)", "Scaletopia")).toBe(true);
    expect(namesCompatible("Bigleap", "Big Leap")).toBe(true);
    expect(namesCompatible("Go Fish Digital", "Go fish Digital - Active")).toBe(true);
    expect(namesCompatible("Bigleap", "Kodif - Active")).toBe(false);
    expect(namesCompatible("", "Kodif")).toBe(false);
  });

  it("recognises GHL's retired sub-account names", () => {
    expect(isRetiredLocationName("Inactive #6")).toBe(true);
    expect(isRetiredLocationName("Banned # 1")).toBe(true);
    expect(isRetiredLocationName("Not working #2")).toBe(true);
    expect(isRetiredLocationName("Kodif - Active")).toBe(false);
    expect(isRetiredLocationName(null)).toBe(false);
  });
});

describe("planClientSync", () => {
  it("inserts a live GHL location that no row holds, with its verified EmailBison key", () => {
    const plan = planClientSync(
      inputs({
        ghl: [ghl({ airtableName: "DTCo", locationId: "LOC_DTCO", bisonRecordId: "recEB" })],
        bison: [bison({ airtableRecordId: "recEB", airtableName: "DTCo", workspace: { id: 122, name: "DTCo" } })],
      })
    );
    expect(plan.inserts).toEqual([
      expect.objectContaining({
        name: "DTCo",
        slug: "dtco",
        ghlLocationId: "LOC_DTCO",
        ghlApiKey: "pit-LOC_DTCO",
        emailbisonApiKey: "eb-recEB",
        emailbisonBaseUrl: "https://send.scaletopia.io",
      }),
    ]);
    expect(plan.fills).toEqual([]);
  });

  it("does not wire an EmailBison key that belongs to another client's workspace", () => {
    const plan = planClientSync(
      inputs({
        ghl: [ghl({ airtableName: "Seedx", locationId: "LOC_S", bisonRecordId: "recEB" })],
        bison: [bison({ airtableRecordId: "recEB", airtableName: "Seedx", workspace: { id: 127, name: "API's Team" } })],
      })
    );
    expect(plan.inserts[0]).toMatchObject({ name: "Seedx", emailbisonApiKey: null, emailbisonBaseUrl: null });
  });

  it("skips Airtable 'Active' rows whose location GHL has retired or the key cannot read", () => {
    const plan = planClientSync(
      inputs({
        ghl: [
          ghl({ airtableName: "Acceler8", locationId: "LOC_OLD", liveName: "Inactive #6" }),
          ghl({ airtableName: "Leadgenix", locationId: "LOC_DEAD_KEY", liveName: null }),
        ],
      })
    );
    expect(plan.inserts).toEqual([]);
    expect(plan.notes.map((n) => [n.kind, n.name])).toEqual([
      ["skipped", "Acceler8"],
      ["skipped", "Leadgenix"],
    ]);
  });

  it("ignores non-Active Airtable rows", () => {
    const plan = planClientSync(
      inputs({ ghl: [ghl({ airtableName: "Big Leap", locationId: "LOC_BL", status: "Non Active" })] })
    );
    expect(plan.inserts).toEqual([]);
    expect(plan.notes).toEqual([]);
  });

  it("links an existing row on the same location and only fills credentials that are empty", () => {
    const plan = planClientSync(
      inputs({
        clients: [
          client({ name: "Chamber Media Secondary", slug: "cms", ghlLocationId: "LOC_CMS", hasGhlKey: true }),
          client({ name: "Redo", slug: "redo", ghlLocationId: "LOC_REDO", hasGhlKey: true, hasEbKey: true, ebWorkspaceId: 98 }),
        ],
        ghl: [
          ghl({ airtableName: "Chamber Media Secondary", locationId: "LOC_CMS", bisonRecordId: "recCM" }),
          ghl({ airtableName: "Redo", locationId: "LOC_REDO", bisonRecordId: "recRedo" }),
        ],
        bison: [
          bison({ airtableRecordId: "recCM", airtableName: "Chamber Media", workspace: { id: 53, name: "Chamber Media" } }),
          bison({ airtableRecordId: "recRedo", airtableName: "Redo", workspace: { id: 98, name: "Redo" } }),
        ],
      })
    );
    expect(plan.inserts).toEqual([]);
    expect(plan.linked).toEqual(["Chamber Media Secondary", "Redo"]);
    expect(plan.fills).toEqual([expect.objectContaining({ clientId: "id-cms", emailbisonApiKey: "eb-recCM" })]);
    expect(plan.fills[0]).not.toHaveProperty("ghlApiKey");
  });

  it("adds a new client on a recycled location instead of treating the old client's row as it", () => {
    // Big Leap's row still points at the location GHL now names Kodif.
    const plan = planClientSync(
      inputs({
        clients: [client({ name: "Bigleap", slug: "bigleap", ghlLocationId: "LOC_K", hasGhlKey: true })],
        ghl: [ghl({ airtableName: "Kodif", locationId: "LOC_K" })],
        liveNameByLocation: { LOC_K: "Kodif - Active" },
      })
    );
    expect(plan.inserts.map((i) => i.name)).toEqual(["Kodif"]);
    expect(plan.notes).toEqual([expect.objectContaining({ kind: "stale", name: "Bigleap" })]);
  });

  it("reports, never inserts, a live location whose name an existing row already uses", () => {
    const plan = planClientSync(
      inputs({
        clients: [client({ name: "Score More Clients", slug: "dma", ghlLocationId: "LOC_INTERNAL", hasGhlKey: true })],
        ghl: [ghl({ airtableName: "Score More Clients", locationId: "LOC_SMC" })],
      })
    );
    expect(plan.inserts).toEqual([]);
    expect(plan.notes).toEqual([expect.objectContaining({ kind: "conflict", name: "Score More Clients" })]);
  });

  it("names duplicate Airtable names after GHL's own name, and keeps slugs unique", () => {
    const plan = planClientSync(
      inputs({
        clients: [client({ name: "Old", slug: "scaletopia_default" })],
        ghl: [
          ghl({ airtableName: "Scaletopia", locationId: "LOC_A", liveName: "Scaletopia (A2P verified) - Active" }),
          ghl({ airtableName: "Scaletopia", locationId: "LOC_B", liveName: "Scaletopia (Default) - Active" }),
        ],
      })
    );
    expect(plan.inserts.map((i) => [i.name, i.slug])).toEqual([
      ["Scaletopia (A2P verified)", "scaletopia_a2p_verified"],
      ["Scaletopia (Default)", "scaletopia_default_2"],
    ]);
  });

  it("inserts an EmailBison-only workspace no row holds, but not one already held", () => {
    const plan = planClientSync(
      inputs({
        clients: [client({ name: "Growth Lab", slug: "growth_lab", hasEbKey: true, ebWorkspaceId: 86 })],
        bison: [
          bison({ airtableRecordId: "recNew", airtableName: "Rixxo", workspace: { id: 71, name: "Rixxo" } }),
          bison({ airtableRecordId: "recGLS", airtableName: "Growth Lab Secondary", workspace: { id: 86, name: "Growth Lab" } }),
        ],
      })
    );
    expect(plan.inserts).toEqual([
      expect.objectContaining({ name: "Rixxo", ghlLocationId: null, emailbisonApiKey: "eb-recNew" }),
    ]);
  });

  it("ignores test-suite leftover rows when matching names", () => {
    const plan = planClientSync(
      inputs({
        clients: [client({ name: "DTCo", slug: "test_clients_ts_abc" })],
        ghl: [ghl({ airtableName: "DTCo", locationId: "LOC_DTCO" })],
      })
    );
    expect(plan.inserts.map((i) => i.name)).toEqual(["DTCo"]);
  });

  it("flags existing rows on retired locations", () => {
    const plan = planClientSync(
      inputs({
        clients: [client({ name: "Acceler8", slug: "acceler8", ghlLocationId: "LOC_OLD", hasGhlKey: true })],
        liveNameByLocation: { LOC_OLD: "Inactive #6" },
      })
    );
    expect(plan.notes).toEqual([expect.objectContaining({ kind: "stale", name: "Acceler8" })]);
  });
});
