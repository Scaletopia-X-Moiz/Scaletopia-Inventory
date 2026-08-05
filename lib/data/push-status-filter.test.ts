import { describe, expect, it } from "vitest";
import {
  parsePushStatusFilter,
  pushStatusRpcPayload,
} from "@/lib/data/push-status-filter";

const CLIENT = "11111111-1111-1111-1111-111111111111";

function sp(entries: Record<string, string>): URLSearchParams {
  return new URLSearchParams(entries);
}

describe("parsePushStatusFilter", () => {
  it("parses when all three params are present & valid", () => {
    expect(
      parsePushStatusFilter(sp({ pushClient: CLIENT, pushPlatform: "ghl", pushStatus: "pushed" }))
    ).toEqual({ clientId: CLIENT, platform: "ghl", status: "pushed" });

    expect(
      parsePushStatusFilter(sp({ pushClient: CLIENT, pushPlatform: "emailbison", pushStatus: "not_pushed" }))
    ).toEqual({ clientId: CLIENT, platform: "emailbison", status: "not_pushed" });
  });

  it("is undefined when all params are absent", () => {
    expect(parsePushStatusFilter(sp({}))).toBeUndefined();
  });

  it("is undefined when only some params are present", () => {
    expect(parsePushStatusFilter(sp({ pushClient: CLIENT }))).toBeUndefined();
    expect(parsePushStatusFilter(sp({ pushClient: CLIENT, pushPlatform: "ghl" }))).toBeUndefined();
    expect(parsePushStatusFilter(sp({ pushPlatform: "ghl", pushStatus: "pushed" }))).toBeUndefined();
  });

  it("is undefined for an invalid platform or status", () => {
    expect(
      parsePushStatusFilter(sp({ pushClient: CLIENT, pushPlatform: "hubspot", pushStatus: "pushed" }))
    ).toBeUndefined();
    expect(
      parsePushStatusFilter(sp({ pushClient: CLIENT, pushPlatform: "ghl", pushStatus: "maybe" }))
    ).toBeUndefined();
  });

  it("treats an empty pushClient as absent", () => {
    expect(
      parsePushStatusFilter(sp({ pushClient: "", pushPlatform: "ghl", pushStatus: "pushed" }))
    ).toBeUndefined();
  });
});

describe("pushStatusRpcPayload", () => {
  it("returns null when the filter is inactive", () => {
    expect(pushStatusRpcPayload(undefined)).toBeNull();
  });

  it("returns the { clientId, platform, status } shape when active", () => {
    expect(
      pushStatusRpcPayload({ clientId: CLIENT, platform: "ghl", status: "not_pushed" })
    ).toEqual({ clientId: CLIENT, platform: "ghl", status: "not_pushed" });
  });
});
