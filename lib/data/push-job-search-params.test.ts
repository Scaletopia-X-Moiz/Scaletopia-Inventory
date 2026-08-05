import { describe, expect, it } from "vitest";
import { parsePersonFilters } from "@/lib/data/people-search-params";
import { parseCompanyFilters } from "@/lib/data/companies-search-params";

// The deep-link buttons (#123) carry the run through `?pushJobId=<id>` (plus an
// optional `?pushJobOutcome=succeeded|failed`), and both tables read filters from
// the URL through these parsers. Lock that URL contract so the buttons and the
// filter chip can rely on the exact param names.
describe("pushJobId search-param parsing", () => {
  for (const [name, parse] of [
    ["parsePersonFilters", parsePersonFilters],
    ["parseCompanyFilters", parseCompanyFilters],
  ] as const) {
    describe(name, () => {
      it("reads pushJobId and a valid pushJobOutcome", () => {
        const filters = parse(new URLSearchParams("pushJobId=job-123&pushJobOutcome=succeeded"));
        expect(filters.pushJobId).toBe("job-123");
        expect(filters.pushJobOutcome).toBe("succeeded");
      });

      it("defaults pushJobOutcome to undefined when absent or invalid", () => {
        expect(parse(new URLSearchParams("pushJobId=job-123")).pushJobOutcome).toBeUndefined();
        expect(
          parse(new URLSearchParams("pushJobId=job-123&pushJobOutcome=bogus")).pushJobOutcome
        ).toBeUndefined();
      });

      it("leaves pushJobId undefined when not present", () => {
        expect(parse(new URLSearchParams("q=acme")).pushJobId).toBeUndefined();
      });
    });
  }
});
