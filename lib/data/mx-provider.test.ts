import { describe, expect, it } from "vitest";
import {
  isMxProviderFilterActive,
  MX_PROVIDER_PARAM,
  mxProviderExcludeOrClause,
  mxProviderLabel,
  sanitizeMxProviderFilter,
} from "@/lib/data/mx-provider";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";
import {
  needsMatchingRpc,
  toFilterOptionsRpcPayload as personPayload,
} from "@/lib/data/people";
import { toFilterOptionsRpcPayload as companyPayload } from "@/lib/data/companies";

// Pure logic for the ESP filter (ticket #25). The end-to-end count checks
// against the live table are in esp-filter.test.ts.

describe("mxProviderLabel", () => {
  it("labels the four real ESP values", () => {
    expect(mxProviderLabel("google")).toBe("Google");
    expect(mxProviderLabel("microsoft")).toBe("Microsoft (Outlook)");
    expect(mxProviderLabel("other")).toBe("Other ESP");
    expect(mxProviderLabel("none")).toBe("No mail server");
  });

  it("falls back to the raw value for an unmapped provider, and '' for none", () => {
    expect(mxProviderLabel("zoho")).toBe("zoho");
    expect(mxProviderLabel(null)).toBe("");
    expect(mxProviderLabel(undefined)).toBe("");
  });
});

describe("sanitizeMxProviderFilter", () => {
  it("keeps slug values and drops anything that could break a PostgREST clause", () => {
    expect(
      sanitizeMxProviderFilter({
        include: ["google", "a,b", "x)", "micro soft"],
        exclude: ["none", "or(1=1)"],
      })
    ).toEqual({ include: ["google"], exclude: ["none"] });
  });

  it("passes undefined through", () => {
    expect(sanitizeMxProviderFilter(undefined)).toBeUndefined();
  });
});

describe("isMxProviderFilterActive", () => {
  it("is active with any include or exclude value, inactive when empty or absent", () => {
    expect(isMxProviderFilterActive(undefined)).toBe(false);
    expect(isMxProviderFilterActive({ include: [], exclude: [] })).toBe(false);
    expect(isMxProviderFilterActive({ include: ["google"], exclude: [] })).toBe(true);
    expect(isMxProviderFilterActive({ include: [], exclude: ["none"] })).toBe(true);
  });
});

describe("mxProviderExcludeOrClause", () => {
  it("keeps NULL-ESP rows, matching the SQL RPC exclude semantics", () => {
    expect(mxProviderExcludeOrClause("mx_provider", ["none", "other"])).toBe(
      "mx_provider.is.null,mx_provider.not.in.(none,other)"
    );
  });
});

describe("ESP URL params", () => {
  const sp = new URLSearchParams();
  sp.append(MX_PROVIDER_PARAM, "google");
  sp.append(MX_PROVIDER_PARAM, "microsoft");
  sp.append(`${MX_PROVIDER_PARAM}_exclude`, "none");
  sp.append(`${MX_PROVIDER_PARAM}_exclude`, "bad,value");

  it("uses the esp / esp_exclude param pair", () => {
    expect(MX_PROVIDER_PARAM).toBe("esp");
  });

  it("parsePersonFilters reads and sanitizes the ESP filter", () => {
    expect(parsePersonFilters(sp).mxProvider).toEqual({ include: ["google", "microsoft"], exclude: ["none"] });
  });

  it("parseCompanyFilters reads and sanitizes the ESP filter", () => {
    expect(parseCompanyFilters(sp).mxProvider).toEqual({ include: ["google", "microsoft"], exclude: ["none"] });
  });

  it("no ESP params parse to an inactive filter", () => {
    expect(isMxProviderFilterActive(parsePersonFilters(new URLSearchParams()).mxProvider)).toBe(false);
  });
});

describe("RPC payloads carry the ESP filter", () => {
  it("person payload sends mxProvider, defaulting to empty arrays", () => {
    expect(personPayload({}).mxProvider).toEqual({ include: [], exclude: [] });
    expect(personPayload({ mxProvider: { include: ["google"], exclude: [] } }).mxProvider).toEqual({
      include: ["google"],
      exclude: [],
    });
  });

  it("company payload sends mxProvider, defaulting to empty arrays", () => {
    expect(companyPayload({}).mxProvider).toEqual({ include: [], exclude: [] });
    expect(companyPayload({ mxProvider: { include: [], exclude: ["none"] } }).mxProvider).toEqual({
      include: [],
      exclude: ["none"],
    });
  });
});

describe("needsMatchingRpc (People)", () => {
  it("routes an active ESP filter through the SQL RPC, since ESP lives on the company", () => {
    expect(needsMatchingRpc({})).toBe(false);
    expect(needsMatchingRpc({ mxProvider: { include: [], exclude: [] } })).toBe(false);
    expect(needsMatchingRpc({ mxProvider: { include: ["google"], exclude: [] } })).toBe(true);
    expect(needsMatchingRpc({ mxProvider: { include: [], exclude: ["none"] } })).toBe(true);
  });
});
