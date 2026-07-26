import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const read = (p: string) => readFileSync(path.resolve(__dirname, p), "utf8");

describe("bug 5a: filter dropdown gets its own scroll container", () => {
  const src = read("./shared/filter-popover.tsx");

  it("the shared Popover.Content has a bounded max-height", () => {
    expect(src).toMatch(/max-h-\[/);
  });

  it("the shared Popover.Content scrolls internally (overflow-y-auto)", () => {
    expect(src).toContain("overflow-y-auto");
  });

  it("wheel scroll does not chain to the page (overscroll-contain)", () => {
    expect(src).toContain("overscroll-contain");
  });
});

describe("bug 5b: Re-verify Phone removed from Companies table only", () => {
  const companies = read("./companies/companies-results-client.tsx");
  const people = read("./people/people-results-client.tsx");

  it("Companies toolbar keeps the email reverify button", () => {
    expect(companies).toContain('endpoint="/api/companies/reverify"');
  });

  it("Companies toolbar no longer has the phone reverify button", () => {
    expect(companies).not.toContain("/api/companies/reverify-phone");
  });

  it("People toolbar keeps BOTH email and phone reverify buttons", () => {
    expect(people).toContain('endpoint="/api/people/reverify"');
    expect(people).toContain('endpoint="/api/people/reverify-phone"');
  });
});
