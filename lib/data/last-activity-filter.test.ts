import { describe, expect, it } from "vitest";
import {
  buildLastActivityFilter,
  lastActivityFilterLabel,
  parseLastActivityFilter,
} from "@/lib/data/last-activity-filter";

const sp = (query: string) => new URLSearchParams(query);

describe("parseLastActivityFilter", () => {
  it("is inactive until both a client and an operator are present", () => {
    expect(parseLastActivityFilter(sp(""))).toBeUndefined();
    expect(parseLastActivityFilter(sp("activityClient=c1"))).toBeUndefined();
    expect(parseLastActivityFilter(sp("activityOp=empty"))).toBeUndefined();
  });

  it("parses the two presence operators", () => {
    expect(parseLastActivityFilter(sp("activityClient=c1&activityOp=empty"))).toEqual({
      clientId: "c1",
      op: "empty",
    });
    expect(parseLastActivityFilter(sp("activityClient=c1&activityOp=not_empty"))).toEqual({
      clientId: "c1",
      op: "not_empty",
    });
  });

  it("rejects an unknown operator rather than guessing", () => {
    expect(parseLastActivityFilter(sp("activityClient=c1&activityOp=sometimes"))).toBeUndefined();
  });

  it("widens a between range to whole days, so the end date is inclusive", () => {
    expect(
      parseLastActivityFilter(sp("activityClient=c1&activityOp=between&activityFrom=2026-01-01&activityTo=2026-01-31"))
    ).toEqual({
      clientId: "c1",
      op: "between",
      from: "2026-01-01T00:00:00.000Z",
      to: "2026-01-31T23:59:59.999Z",
    });
  });

  it("accepts a one-sided range but not a range with no bounds at all", () => {
    expect(parseLastActivityFilter(sp("activityClient=c1&activityOp=between&activityFrom=2026-01-01"))).toMatchObject({
      from: "2026-01-01T00:00:00.000Z",
      to: null,
    });
    expect(parseLastActivityFilter(sp("activityClient=c1&activityOp=between"))).toBeUndefined();
  });

  it("drops an unparseable bound instead of throwing", () => {
    expect(
      parseLastActivityFilter(sp("activityClient=c1&activityOp=between&activityFrom=banana&activityTo=2026-01-31"))
    ).toMatchObject({ from: null, to: "2026-01-31T23:59:59.999Z" });
  });

  it("requires a positive whole day count for within_days", () => {
    expect(parseLastActivityFilter(sp("activityClient=c1&activityOp=within_days&activityDays=60"))).toEqual({
      clientId: "c1",
      op: "within_days",
      days: 60,
    });
    expect(parseLastActivityFilter(sp("activityClient=c1&activityOp=within_days&activityDays=0"))).toBeUndefined();
    expect(parseLastActivityFilter(sp("activityClient=c1&activityOp=within_days&activityDays=-5"))).toBeUndefined();
    expect(parseLastActivityFilter(sp("activityClient=c1&activityOp=within_days&activityDays=x"))).toBeUndefined();
    expect(parseLastActivityFilter(sp("activityClient=c1&activityOp=within_days"))).toBeUndefined();
  });

  it("floors a fractional day count", () => {
    expect(
      parseLastActivityFilter(sp("activityClient=c1&activityOp=within_days&activityDays=7.9"))
    ).toMatchObject({ days: 7 });
  });

  it("ignores stale params belonging to another operator", () => {
    // Switching from "within 30 days" to "is empty" leaves activityDays in the
    // URL if the caller doesn't clear it; the result must still be "is empty".
    expect(parseLastActivityFilter(sp("activityClient=c1&activityOp=empty&activityDays=30"))).toEqual({
      clientId: "c1",
      op: "empty",
    });
  });
});

describe("buildLastActivityFilter", () => {
  it("mirrors the parser's all-or-nothing rule, so the UI can't emit a shape the URL rejects", () => {
    expect(buildLastActivityFilter(undefined, "empty")).toBeUndefined();
    expect(buildLastActivityFilter("c1", undefined)).toBeUndefined();
    expect(buildLastActivityFilter("c1", "between", { from: null, to: null })).toBeUndefined();
    expect(buildLastActivityFilter("c1", "within_days", { days: Number.NaN })).toBeUndefined();
  });
});

describe("lastActivityFilterLabel", () => {
  it("names the client, because the date is per sub-account", () => {
    expect(lastActivityFilterLabel({ clientId: "c1", op: "empty" }, "Acme")).toBe(
      "Last activity is empty for Acme"
    );
    expect(lastActivityFilterLabel({ clientId: "c1", op: "within_days", days: 1 }, "Acme")).toBe(
      "Last activity within last 1 day for Acme"
    );
    expect(
      lastActivityFilterLabel(
        { clientId: "c1", op: "between", from: "2026-01-01T00:00:00.000Z", to: null },
        "Acme"
      )
    ).toBe("Last activity after 2026-01-01 for Acme");
  });
});
