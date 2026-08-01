import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { listPushHistory } from "@/lib/data/push-history";

const TEST_PREFIX = "__test-push-history__";

function testLinkedin(slug: string): string {
  return `https://linkedin.com/in/${TEST_PREFIX}${slug}`;
}

async function cleanupAll() {
  const { data: people } = await supabaseAdmin
    .from("people")
    .select("id")
    .like("linkedin_url", `%${TEST_PREFIX}%`);
  const personIds = (people ?? []).map((p) => (p as { id: string }).id);
  if (personIds.length > 0) {
    await supabaseAdmin.from("platform_pushes").delete().in("person_id", personIds);
  }
  await supabaseAdmin.from("people").delete().like("linkedin_url", `%${TEST_PREFIX}%`);
  await supabaseAdmin.from("clients").delete().like("slug", `${TEST_PREFIX}%`);
}

beforeAll(cleanupAll);
afterAll(cleanupAll);

let counter = 0;
function unique(label: string): string {
  counter++;
  return `${TEST_PREFIX}${label}-${counter}`;
}

async function insertPerson(fullName: string): Promise<string> {
  const slug = unique("person");
  const { data, error } = await supabaseAdmin
    .from("people")
    .insert({ linkedin_url: testLinkedin(slug), full_name: fullName })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function insertClient(name: string): Promise<string> {
  const slug = unique("client");
  const { data, error } = await supabaseAdmin
    .from("clients")
    .insert({ slug, name })
    .select("id")
    .single();
  if (error) throw error;
  return (data as { id: string }).id;
}

async function insertPush(overrides: Record<string, unknown>) {
  const { error } = await supabaseAdmin.from("platform_pushes").insert(overrides);
  if (error) throw error;
}

describe("listPushHistory", () => {
  it("returns paginated rows joined to person and client, newest first", async () => {
    const personId = await insertPerson("Push History Person");
    const clientId = await insertClient(unique("Push History Client"));

    await insertPush({
      person_id: personId,
      client_id: clientId,
      platform: "ghl",
      campaign_tag: "spring-campaign",
      platform_contact_id: "contact-1",
      pushed_by_email: "actor@example.com",
      pushed_at: "2026-01-01T00:00:00Z",
    });
    await insertPush({
      person_id: personId,
      client_id: clientId,
      platform: "emailbison",
      campaign_tag: "fall-campaign",
      platform_contact_id: "contact-2",
      pushed_by_email: "actor@example.com",
      pushed_at: "2026-02-01T00:00:00Z",
    });

    const { rows, total } = await listPushHistory({ clientId }, 1, 0);

    expect(total).toBe(2);
    expect(rows).toHaveLength(1);
    const [row] = rows;
    expect(row.platform).toBe("emailbison");
    expect(row.person).toEqual({ id: personId, name: "Push History Person" });
    expect(row.client?.id).toBe(clientId);
    expect(row.campaignTag).toBe("fall-campaign");
    expect(row.platformContactId).toBe("contact-2");
    expect(row.pushedByEmail).toBe("actor@example.com");

    const { rows: page2 } = await listPushHistory({ clientId }, 1, 1);
    expect(page2).toHaveLength(1);
    expect(page2[0].platform).toBe("ghl");
  });

  it("paginates stably across pages when pushed_at ties", async () => {
    const personId = await insertPerson("Tiebreak Person");
    const clientId = await insertClient(unique("Tiebreak Client"));
    const tiedTimestamp = "2026-05-01T00:00:00Z";

    for (let i = 0; i < 3; i++) {
      await insertPush({
        person_id: personId,
        client_id: clientId,
        platform: `tiebreak-${i}`,
        pushed_at: tiedTimestamp,
      });
    }

    const { rows: page1 } = await listPushHistory({ clientId }, 2, 0);
    const { rows: page2 } = await listPushHistory({ clientId }, 2, 2);

    expect(page1).toHaveLength(2);
    expect(page2).toHaveLength(1);
    const seenIds = new Set([...page1, ...page2].map((r) => r.id));
    expect(seenIds.size).toBe(3);
  });

  it("narrows results by platform filter", async () => {
    const personId = await insertPerson("Platform Filter Person");
    const clientId = await insertClient(unique("Platform Filter Client"));

    await insertPush({
      person_id: personId,
      client_id: clientId,
      platform: "ghl",
      pushed_at: "2026-03-01T00:00:00Z",
    });
    await insertPush({
      person_id: personId,
      client_id: clientId,
      platform: "emailbison",
      pushed_at: "2026-03-02T00:00:00Z",
    });

    const { rows, total } = await listPushHistory({ clientId, platform: "ghl" });

    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].platform).toBe("ghl");
  });

  it("narrows results by client filter", async () => {
    const personId = await insertPerson("Client Filter Person");
    const clientAId = await insertClient(unique("Client Filter A"));
    const clientBId = await insertClient(unique("Client Filter B"));

    await insertPush({
      person_id: personId,
      client_id: clientAId,
      platform: "ghl",
      pushed_at: "2026-04-01T00:00:00Z",
    });
    await insertPush({
      person_id: personId,
      client_id: clientBId,
      platform: "ghl",
      pushed_at: "2026-04-02T00:00:00Z",
    });

    const { rows, total } = await listPushHistory({ clientId: clientAId });

    expect(total).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0].client?.id).toBe(clientAId);
  });
});
