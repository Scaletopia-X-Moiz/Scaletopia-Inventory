import { describe, it } from "vitest";
import { listClients } from "@/lib/data/clients";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { runGhlActivitySync } from "@/lib/ghl/sync-activity";

const MARK = "__live-activity-probe__";

describe("live probe", () => {
  it("runs", async () => {
    const all = await listClients();
    const internal = all.find((c) => c.slug === "internal")!;
    const testing = all.find((c) => c.slug === "testing")!;

    try {
      await runGhlActivitySync(testing);
      console.log("STALE: unexpectedly succeeded");
    } catch (e) {
      console.log("STALE token ->", (e as Error).message);
    }

    const { data: existing } = await supabaseAdmin
      .from("platform_pushes").select("person_id,platform_contact_id")
      .eq("client_id", testing.id).eq("platform", "ghl");
    const rows = (existing ?? []) as { person_id: string; platform_contact_id: string }[];
    await supabaseAdmin.from("platform_pushes").upsert(
      rows.map((r) => ({ person_id: r.person_id, client_id: internal.id, platform: "ghl",
        platform_contact_id: r.platform_contact_id, campaign_tag: MARK })),
      { onConflict: "person_id,client_id,platform" });

    let t = Date.now();
    const first = await runGhlActivitySync(internal);
    console.log("RUN1 (cold, full sweep)", Date.now() - t, "ms", JSON.stringify({
      sweptPages: first.sweptPages, enqueued: first.enqueued, fetched: first.fetched,
      updated: first.updated, skipped: first.skipped, errors: first.errors, done: first.done }));
    if (first.failed.length) console.log("failures:", JSON.stringify(first.failed.slice(0,3)));

    t = Date.now();
    const second = await runGhlActivitySync(internal);
    console.log("RUN2 (incremental)", Date.now() - t, "ms", JSON.stringify({
      sweptPages: second.sweptPages, enqueued: second.enqueued, fetched: second.fetched,
      updated: second.updated, skipped: second.skipped, errors: second.errors, done: second.done }));

    const { data: result } = await supabaseAdmin.from("platform_pushes")
      .select("platform_contact_id,last_activity_at,last_message_type,last_message_direction")
      .eq("client_id", internal.id).eq("platform", "ghl");
    console.log("DATES", JSON.stringify(result));
    const { count: msgs } = await supabaseAdmin.from("ghl_messages")
      .select("id", { count: "exact", head: true }).eq("client_id", internal.id);
    console.log("stored messages:", msgs);

    await supabaseAdmin.from("ghl_messages").delete().eq("client_id", internal.id);
    await supabaseAdmin.from("platform_pushes").delete().eq("client_id", internal.id).eq("campaign_tag", MARK);
    await supabaseAdmin.from("ghl_activity_queue").delete().eq("client_id", internal.id);
    await supabaseAdmin.from("ghl_activity_sweeps").delete().eq("client_id", internal.id);
    console.log("cleaned up", rows.length, "mirrored rows");
  }, 600000);
});
