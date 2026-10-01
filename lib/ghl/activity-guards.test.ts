import { describe, expect, it } from "vitest";
import { mayHaveMessages } from "@/lib/ghl/sync-activity";
import type { PushedContact } from "@/lib/data/ghl-activity";

/** The three states of `platform_pushes.was_deduped` (Decision 5, layer 1).
 *
 * Worth its own file because getting this wrong is silent in both directions:
 * `= true` drops every row pushed before the column existed (they are all
 * NULL) and the sync reads nothing while reporting success; `=== true` as a
 * skip test spends an export call on every contact GHL created seconds ago. */

function pushed(wasDeduped: boolean | null, personId = "p1"): PushedContact {
  return {
    personId,
    ghlContactId: "c1",
    lastActivityAt: null,
    activitySyncedAt: null,
    wasDeduped,
  };
}

describe("mayHaveMessages", () => {
  it("reads a contact GHL matched against an existing one", () => {
    expect(mayHaveMessages([pushed(true)])).toBe(true);
  });

  it("reads a contact whose flag is unknown — NULL is not 'brand new'", () => {
    // Every row that predates the column is NULL. Treating NULL as a skip
    // would exclude the entire existing corpus from every post-push sync,
    // forever, with no error anywhere.
    expect(mayHaveMessages([pushed(null)])).toBe(true);
  });

  it("skips a contact GHL positively reported as freshly created", () => {
    expect(mayHaveMessages([pushed(false)])).toBe(false);
  });

  it("reads a shared GHL contact when ANY of our people's pushes deduped", () => {
    // GHL dedupes on phone, so two of our people can point at one GHL contact.
    // If either push matched an existing contact, the conversation exists.
    expect(mayHaveMessages([pushed(false, "p1"), pushed(true, "p2")])).toBe(true);
    expect(mayHaveMessages([pushed(false, "p1"), pushed(null, "p2")])).toBe(true);
  });

  it("skips only when every push row agrees the contact was created fresh", () => {
    expect(mayHaveMessages([pushed(false, "p1"), pushed(false, "p2")])).toBe(false);
  });

  it("skips a contact we hold no push row for at all", () => {
    expect(mayHaveMessages(undefined)).toBe(false);
    expect(mayHaveMessages([])).toBe(false);
  });
});
