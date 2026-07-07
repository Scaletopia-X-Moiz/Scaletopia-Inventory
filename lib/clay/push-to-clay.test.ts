import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  runCompaniesClayPush,
  isValidWebhookUrl,
  postWithRetry,
  FAILED_PREVIEW,
  RATE_LIMIT_MAX_DELAY_MS,
} from "@/lib/clay/push-to-clay";
import { includeOnly } from "@/lib/data/include-exclude";

const TEST_PREFIX = "__test-clay-push__";
const WEBHOOK_URL = "https://example.com/test-clay-webhook";

function testDomain(niche: string, slug: string) {
  return `${TEST_PREFIX}${niche}-${slug}.example.com`;
}

async function cleanup() {
  await supabaseAdmin.from("companies").delete().like("domain", `${TEST_PREFIX}%`);
}

beforeAll(cleanup);
afterAll(cleanup);

async function seedCompanies(
  niche: string,
  rows: { slug: string; pushed?: boolean }[]
) {
  const { error } = await supabaseAdmin.from("companies").insert(
    rows.map((r) => ({
      domain: testDomain(niche, r.slug),
      company_name: `Clay Test ${r.slug}`,
      niche,
      pushed_to_clay: r.pushed ?? false,
    }))
  );
  if (error) throw error;
}

function okFetch(): typeof fetch {
  return vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
}

let nicheCounter = 0;
function uniqueNiche(label: string) {
  nicheCounter++;
  return `${TEST_PREFIX}${label}-${nicheCounter}`;
}

describe("isValidWebhookUrl", () => {
  it("accepts https URLs and rejects everything else", () => {
    expect(isValidWebhookUrl("https://api.clay.com/v3/sources/webhook/abc")).toBe(true);
    expect(isValidWebhookUrl("http://example.com")).toBe(false);
    expect(isValidWebhookUrl("not a url")).toBe(false);
    expect(isValidWebhookUrl("")).toBe(false);
    expect(isValidWebhookUrl(undefined)).toBe(false);
  });
});

describe("postWithRetry 429 Retry-After handling", () => {
  /** Replace the real setTimeout with one that records the requested delay and
   * fires the callback immediately, so we can assert what the retry *would*
   * have waited without actually sleeping. */
  function captureRetryDelays() {
    const delays: number[] = [];
    const spy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation(((fn: (...args: unknown[]) => void, delay?: number) => {
        delays.push(delay ?? 0);
        fn();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      }) as unknown as typeof setTimeout);
    return { delays, restore: () => spy.mockRestore() };
  }

  function headers(retryAfter: string): Response["headers"] {
    return { get: (h: string) => (h.toLowerCase() === "retry-after" ? retryAfter : null) } as
      unknown as Response["headers"];
  }

  it("clamps an absurd numeric Retry-After to RATE_LIMIT_MAX_DELAY_MS", async () => {
    const { delays, restore } = captureRetryDelays();
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      // 100000 seconds -> 100_000_000ms, which must never be honored verbatim.
      if (call === 1) return { ok: false, status: 429, headers: headers("100000") } as Response;
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    const result = await postWithRetry(fetchImpl, WEBHOOK_URL, { hello: "world" });
    restore();

    expect(result.ok).toBe(true);
    expect(delays.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...delays)).toBeLessThanOrEqual(RATE_LIMIT_MAX_DELAY_MS);
  });

  it("clamps a far-future Retry-After date to RATE_LIMIT_MAX_DELAY_MS", async () => {
    const { delays, restore } = captureRetryDelays();
    const farFuture = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toUTCString();
    let call = 0;
    const fetchImpl = vi.fn(async () => {
      call++;
      if (call === 1) return { ok: false, status: 429, headers: headers(farFuture) } as Response;
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    const result = await postWithRetry(fetchImpl, WEBHOOK_URL, { hello: "world" });
    restore();

    expect(result.ok).toBe(true);
    expect(delays.length).toBeGreaterThanOrEqual(1);
    expect(Math.max(...delays)).toBeLessThanOrEqual(RATE_LIMIT_MAX_DELAY_MS);
  });
});

describe("runCompaniesClayPush", () => {
  it("pushes every matching company, including ones pushed before", async () => {
    const niche = uniqueNiche("all");
    await seedCompanies(niche, [
      { slug: "a" },
      { slug: "b" },
      { slug: "c", pushed: true },
    ]);

    const fetchImpl = okFetch();
    const result = await runCompaniesClayPush({ niche: includeOnly([niche]) }, WEBHOOK_URL, { fetchImpl });

    expect(result.total_matched).toBe(3);
    expect(result.pushed).toBe(3);
    expect(result.errors).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("re-pushes on a second run (no skip-already-pushed)", async () => {
    const niche = uniqueNiche("repeat");
    await seedCompanies(niche, [{ slug: "a" }, { slug: "b" }]);

    const first = await runCompaniesClayPush({ niche: includeOnly([niche]) }, WEBHOOK_URL, { fetchImpl: okFetch() });
    expect(first.pushed).toBe(2);

    const secondFetch = okFetch();
    const second = await runCompaniesClayPush({ niche: includeOnly([niche]) }, WEBHOOK_URL, { fetchImpl: secondFetch });

    expect(second.total_matched).toBe(2);
    expect(second.pushed).toBe(2);
    expect(secondFetch).toHaveBeenCalledTimes(2);
  });

  it("does not abort the batch on a webhook failure", async () => {
    const niche = uniqueNiche("partial-fail");
    await seedCompanies(niche, [{ slug: "ok1" }, { slug: "bad" }, { slug: "ok2" }]);

    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse((init?.body as string) ?? "{}");
      if (body.domain === testDomain(niche, "bad")) {
        return { ok: false, status: 500 } as Response;
      }
      return { ok: true } as Response;
    }) as unknown as typeof fetch;

    const result = await runCompaniesClayPush({ niche: includeOnly([niche]) }, WEBHOOK_URL, { fetchImpl });

    expect(result.total_matched).toBe(3);
    expect(result.pushed).toBe(2);
    expect(result.errors).toBe(1);
    expect(result.failed_companies).toContain("Clay Test bad");
  });

  it("returns an all-zero result for an empty filter match", async () => {
    const niche = uniqueNiche("empty");
    const fetchImpl = okFetch();

    const result = await runCompaniesClayPush({ niche: includeOnly([niche]) }, WEBHOOK_URL, { fetchImpl });

    expect(result).toEqual({
      total_matched: 0,
      pushed: 0,
      errors: 0,
      failed_companies: [],
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects when the webhook URL is invalid", async () => {
    await expect(
      runCompaniesClayPush({ niche: includeOnly([uniqueNiche("bad-url")]) }, "http://insecure.example.com")
    ).rejects.toThrow("valid https webhook URL");
  });

  it("caps failed_companies at FAILED_PREVIEW", async () => {
    const niche = uniqueNiche("many-failures");
    const count = FAILED_PREVIEW + 5;
    await seedCompanies(
      niche,
      Array.from({ length: count }, (_, i) => ({ slug: `fail-${i}` }))
    );

    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 400 }) as unknown as typeof fetch;
    const result = await runCompaniesClayPush({ niche: includeOnly([niche]) }, WEBHOOK_URL, { fetchImpl });

    expect(result.errors).toBe(count);
    expect(result.failed_companies).toHaveLength(FAILED_PREVIEW);
  });
});
