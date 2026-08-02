import { afterEach, describe, expect, it } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  createClient,
  getClientById,
  listActiveClients,
  listClients,
  updateClientCredentials,
} from "@/lib/data/clients";

const TEST_SLUG_PREFIX = "test_clients_ts_";

async function insertClient(overrides: Record<string, unknown> = {}): Promise<string> {
  const slug = `${TEST_SLUG_PREFIX}${Math.random().toString(36).slice(2)}`;
  const { data, error } = await supabaseAdmin
    .from("clients")
    .insert({ slug, name: slug, ...overrides })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

describe("clients data layer", () => {
  const insertedIds: string[] = [];

  afterEach(async () => {
    if (insertedIds.length === 0) return;
    await supabaseAdmin.from("clients").delete().in("id", insertedIds);
    insertedIds.length = 0;
  });

  describe("listActiveClients", () => {
    it("returns an active client and excludes an inactive one", async () => {
      const activeId = await insertClient({ is_active: true });
      const inactiveId = await insertClient({ is_active: false });
      insertedIds.push(activeId, inactiveId);

      const clients = await listActiveClients();
      const ids = clients.map((c) => c.id);
      expect(ids).toContain(activeId);
      expect(ids).not.toContain(inactiveId);
    });

    it("orders results by name ascending", async () => {
      const bId = await insertClient({ is_active: true, name: `${TEST_SLUG_PREFIX}zzz_b` });
      const aId = await insertClient({ is_active: true, name: `${TEST_SLUG_PREFIX}aaa_a` });
      insertedIds.push(bId, aId);

      const clients = await listActiveClients();
      const aIndex = clients.findIndex((c) => c.id === aId);
      const bIndex = clients.findIndex((c) => c.id === bId);
      expect(aIndex).toBeGreaterThanOrEqual(0);
      expect(bIndex).toBeGreaterThan(aIndex);
    });
  });

  describe("listClients", () => {
    it("includes both active and inactive clients", async () => {
      const activeId = await insertClient({ is_active: true });
      const inactiveId = await insertClient({ is_active: false });
      insertedIds.push(activeId, inactiveId);

      const clients = await listClients();
      const ids = clients.map((c) => c.id);
      expect(ids).toContain(activeId);
      expect(ids).toContain(inactiveId);
    });

    it("orders results by name ascending", async () => {
      const bId = await insertClient({ name: `${TEST_SLUG_PREFIX}zzz_b` });
      const aId = await insertClient({ name: `${TEST_SLUG_PREFIX}aaa_a` });
      insertedIds.push(bId, aId);

      const clients = await listClients();
      const aIndex = clients.findIndex((c) => c.id === aId);
      const bIndex = clients.findIndex((c) => c.id === bId);
      expect(aIndex).toBeGreaterThanOrEqual(0);
      expect(bIndex).toBeGreaterThan(aIndex);
    });
  });

  describe("getClientById", () => {
    it("returns the full mapped row", async () => {
      const id = await insertClient({
        name: "Acme",
        ghl_api_key: "ghl-key",
        ghl_location_id: "loc-1",
        emailbison_api_key: "eb-key",
        emailbison_workspace_id: "ws-1",
        is_active: true,
      });
      insertedIds.push(id);

      const client = await getClientById(id);
      expect(client).toMatchObject({
        id,
        name: "Acme",
        ghlApiKey: "ghl-key",
        ghlLocationId: "loc-1",
        emailbisonApiKey: "eb-key",
        emailbisonWorkspaceId: "ws-1",
        isActive: true,
      });
    });

    it("returns null for a nonexistent id", async () => {
      const client = await getClientById("00000000-0000-0000-0000-000000000000");
      expect(client).toBeNull();
    });
  });

  describe("createClient", () => {
    it("creates a new active row with credentials left null", async () => {
      const slug = `${TEST_SLUG_PREFIX}${Math.random().toString(36).slice(2)}`;
      const created = await createClient({ slug, name: "Acme Agency" });
      insertedIds.push(created.id);

      expect(created).toMatchObject({
        slug,
        name: "Acme Agency",
        ghlApiKey: null,
        ghlLocationId: null,
        isActive: true,
      });

      const fetched = await getClientById(created.id);
      expect(fetched).toMatchObject({ slug, name: "Acme Agency" });
    });

    it("throws a unique-violation (23505) when the slug already exists", async () => {
      const slug = `${TEST_SLUG_PREFIX}${Math.random().toString(36).slice(2)}`;
      const first = await createClient({ slug, name: "First" });
      insertedIds.push(first.id);

      await expect(createClient({ slug, name: "Second" })).rejects.toMatchObject({
        code: "23505",
      });
    });
  });

  describe("updateClientCredentials", () => {
    it("updates only the fields provided", async () => {
      const id = await insertClient({ ghl_api_key: "old-key", ghl_location_id: "old-loc" });
      insertedIds.push(id);

      const updated = await updateClientCredentials(id, { ghlApiKey: "new-key" });
      expect(updated.ghlApiKey).toBe("new-key");
      expect(updated.ghlLocationId).toBe("old-loc");
    });

    it("bumps updated_at", async () => {
      const id = await insertClient({});
      insertedIds.push(id);
      const before = await getClientById(id);

      await new Promise((resolve) => setTimeout(resolve, 10));
      const updated = await updateClientCredentials(id, { ghlApiKey: "x" });

      expect(new Date(updated.updatedAt).getTime()).toBeGreaterThan(new Date(before!.updatedAt).getTime());
    });

    it("can clear a field by passing null", async () => {
      const id = await insertClient({ ghl_api_key: "old-key" });
      insertedIds.push(id);

      const updated = await updateClientCredentials(id, { ghlApiKey: null });
      expect(updated.ghlApiKey).toBeNull();
    });

    it("toggles isActive", async () => {
      const id = await insertClient({ is_active: true });
      insertedIds.push(id);

      const updated = await updateClientCredentials(id, { isActive: false });
      expect(updated.isActive).toBe(false);
    });
  });
});
