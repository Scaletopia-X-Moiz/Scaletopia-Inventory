import { describe, expect, it } from "vitest";
import {
  computeContactActivity,
  isActivityMessage,
  sanitizeMessageBody,
  MAX_BODY_CHARS,
  type GhlExportedMessage,
} from "@/lib/ghl/activity-rules";
import { ghlTimeAgo } from "@/lib/utils";

/** The rules that decide which GHL messages count as "last activity", and the
 * formatter that renders the result. Both are settled research
 * (docs/features/ghl-last-activity/handoff.md §12-13) and both are silent
 * when wrong — a bad exclusion rule shows a date GHL doesn't, and a rounding
 * formatter puts most rows off by one — so they're pinned here. */

function message(overrides: Partial<GhlExportedMessage> = {}): GhlExportedMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    conversationId: "conv-1",
    direction: "inbound",
    messageType: "TYPE_SMS",
    body: "hello",
    dateAdded: "2026-09-01T12:00:00.000Z",
    ...overrides,
  };
}

describe("isActivityMessage — the exclusion rule", () => {
  it("counts real messages on every channel", () => {
    for (const type of ["TYPE_SMS", "TYPE_EMAIL", "TYPE_CALL", "TYPE_VOICEMAIL", "TYPE_WHATSAPP"]) {
      expect(isActivityMessage({ messageType: type })).toBe(true);
    }
  });

  it("excludes no-shows and every TYPE_ACTIVITY_* variant", () => {
    // Verified in the GHL UI: contact EAhzGidCP3m2hX7TX74S's only entry is a
    // TYPE_ACTIVITY_APPOINTMENT and the Contacts list shows Last activity
    // blank for it (handoff §12.1).
    for (const type of [
      "TYPE_NO_SHOW",
      "TYPE_ACTIVITY_APPOINTMENT",
      "TYPE_ACTIVITY_CONTACT",
      "TYPE_ACTIVITY_OPPORTUNITY",
      "TYPE_SYSTEM_NOTE",
    ]) {
      expect(isActivityMessage({ messageType: type })).toBe(false);
    }
  });

  it("matches by prefix, so a TYPE_ACTIVITY_* variant GHL adds later is excluded too", () => {
    expect(isActivityMessage({ messageType: "TYPE_ACTIVITY_SOMETHING_NEW" })).toBe(false);
  });

  it("counts an unrecognized or missing type — the deny-list errs toward real activity", () => {
    expect(isActivityMessage({ messageType: "TYPE_FUTURE_CHANNEL" })).toBe(true);
    expect(isActivityMessage({ messageType: null })).toBe(true);
    expect(isActivityMessage({ messageType: undefined })).toBe(true);
  });

  it("does not filter on direction — automated outbound counts (handoff §12.3)", () => {
    expect(isActivityMessage({ messageType: "TYPE_SMS" })).toBe(true);
  });
});

describe("computeContactActivity", () => {
  it("takes the newest qualifying message's own dateAdded", () => {
    const result = computeContactActivity([
      message({ dateAdded: "2026-09-01T12:00:00.000Z", messageType: "TYPE_SMS" }),
      message({ dateAdded: "2026-09-20T08:30:00.000Z", messageType: "TYPE_EMAIL", direction: "outbound" }),
      message({ dateAdded: "2026-09-10T00:00:00.000Z", messageType: "TYPE_CALL" }),
    ]);
    expect(result.lastActivityAt).toBe("2026-09-20T08:30:00.000Z");
    expect(result.lastMessageType).toBe("TYPE_EMAIL");
    expect(result.lastMessageDirection).toBe("outbound");
  });

  it("returns null when every message is an activity event", () => {
    const result = computeContactActivity([
      message({ messageType: "TYPE_ACTIVITY_APPOINTMENT", dateAdded: "2026-09-25T13:03:00.000Z" }),
      message({ messageType: "TYPE_NO_SHOW", dateAdded: "2026-09-24T13:03:00.000Z" }),
    ]);
    expect(result.lastActivityAt).toBeNull();
    expect(result.messages).toEqual([]);
  });

  it("ignores an activity event that is newer than the newest real message", () => {
    // The mixed conversation the handoff flagged as unverified (§12.2's
    // 0-of-30 caveat): if one exists, the real message must still win.
    const result = computeContactActivity([
      message({ messageType: "TYPE_SMS", dateAdded: "2026-09-01T12:00:00.000Z" }),
      message({ messageType: "TYPE_NO_SHOW", dateAdded: "2026-09-28T12:00:00.000Z" }),
    ]);
    expect(result.lastActivityAt).toBe("2026-09-01T12:00:00.000Z");
  });

  it("drops messages with no id or an unparseable date rather than throwing", () => {
    const result = computeContactActivity([
      { id: "", dateAdded: "2026-09-01T12:00:00.000Z" },
      message({ dateAdded: "not a date" }),
      message({ dateAdded: null }),
      message({ id: "keeper", dateAdded: "2026-09-02T12:00:00.000Z" }),
    ]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].ghlMessageId).toBe("keeper");
  });

  it("returns messages newest-first, the order the drawer renders", () => {
    const result = computeContactActivity([
      message({ id: "old", dateAdded: "2026-01-01T00:00:00.000Z" }),
      message({ id: "new", dateAdded: "2026-09-01T00:00:00.000Z" }),
      message({ id: "mid", dateAdded: "2026-05-01T00:00:00.000Z" }),
    ]);
    expect(result.messages.map((m) => m.ghlMessageId)).toEqual(["new", "mid", "old"]);
  });

  it("handles an empty export (a contact with no messages at all)", () => {
    expect(computeContactActivity([])).toMatchObject({
      lastActivityAt: null,
      lastMessageType: null,
      lastMessageDirection: null,
      messages: [],
    });
  });
});

describe("sanitizeMessageBody", () => {
  it("strips tags and decodes the entities email bodies actually carry", () => {
    expect(sanitizeMessageBody("<p>Hi &amp; hello</p><p>there</p>")).toBe("Hi & hello\nthere");
  });

  it("drops style and script contents wholesale", () => {
    expect(sanitizeMessageBody("<style>.a{color:red}</style><p>Body</p>")).toBe("Body");
  });

  it("caps at MAX_BODY_CHARS with an ellipsis", () => {
    const result = sanitizeMessageBody("x".repeat(MAX_BODY_CHARS * 2));
    expect(result).toHaveLength(MAX_BODY_CHARS);
    expect(result?.endsWith("…")).toBe(true);
  });

  it("returns null for empty, whitespace-only, and markup-only bodies", () => {
    expect(sanitizeMessageBody(null)).toBeNull();
    expect(sanitizeMessageBody("")).toBeNull();
    expect(sanitizeMessageBody("   \n ")).toBeNull();
    expect(sanitizeMessageBody("<br/><div></div>")).toBeNull();
  });
});

describe("ghlTimeAgo — truncating relative time", () => {
  const now = new Date("2026-09-30T12:00:00.000Z");
  const ago = (ms: number) => ghlTimeAgo(new Date(now.getTime() - ms).toISOString(), now);
  const DAY = 24 * 60 * 60 * 1000;

  it("floors years — 1.97 years renders '1 year ago' (handoff §13.1)", () => {
    expect(ago(Math.round(1.97 * 365 * DAY))).toBe("1 year ago");
  });

  it("floors weeks — 16 days renders '2 weeks ago' (handoff §13.1)", () => {
    expect(ago(16 * DAY)).toBe("2 weeks ago");
  });

  it("never rounds up at a boundary", () => {
    expect(ago(13 * DAY)).toBe("1 week ago"); // rounding would say 2 weeks
    expect(ago(59 * DAY)).toBe("1 month ago"); // rounding would say 2 months
    expect(ago(Math.round(1.9 * 60 * 60 * 1000))).toBe("1 hour ago");
  });

  it("walks the whole ladder", () => {
    expect(ago(30 * 1000)).toBe("Just now");
    expect(ago(60 * 1000)).toBe("1 minute ago");
    expect(ago(90 * 60 * 1000)).toBe("1 hour ago");
    expect(ago(3 * DAY)).toBe("3 days ago");
    expect(ago(7 * DAY)).toBe("1 week ago");
    expect(ago(30 * DAY)).toBe("1 month ago");
    expect(ago(365 * DAY)).toBe("1 year ago");
  });

  it("leaves no gap between the months and years tiers", () => {
    // floor(364/30) is 12, which would read "12 months"; the largest-unit-first
    // ladder keeps it at 11 and hands 365 days to the years tier.
    expect(ago(364 * DAY)).toBe("11 months ago");
    expect(ago(365 * DAY)).toBe("1 year ago");
  });

  it("renders blank for null and unparseable input", () => {
    expect(ghlTimeAgo(null, now)).toBe("");
    expect(ghlTimeAgo(undefined, now)).toBe("");
    expect(ghlTimeAgo("not a date", now)).toBe("");
  });

  it("clamps a future date to 'Just now' rather than counting backwards", () => {
    expect(ghlTimeAgo(new Date(now.getTime() + 60_000).toISOString(), now)).toBe("Just now");
  });
});
