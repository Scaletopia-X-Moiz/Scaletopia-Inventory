import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ getUser }));

const { getPeopleForEmailBison, getPeopleForEmailBisonByCompanyFilters } = vi.hoisted(() => ({
  getPeopleForEmailBison: vi.fn(),
  getPeopleForEmailBisonByCompanyFilters: vi.fn(),
}));
vi.mock("@/lib/data/people", () => ({
  getPeopleForEmailBison,
  getPeopleForEmailBisonByCompanyFilters,
}));

const { GET } = await import("@/app/api/emailbison/default-field-mapping/route");

const testUser = { id: "user-1", email: "operator@example.com" };

function makeRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/emailbison/default-field-mapping${query}`);
}

function candidate(companyName: string | null, brandName: string | null) {
  return {
    id: "p1",
    displayName: "Jane Doe",
    record: {
      firstName: "Jane",
      lastName: "Doe",
      email: "jane@example.com",
      phone: null,
      companyName,
      brandName,
      title: null,
      website: null,
    },
    customData: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getUser.mockResolvedValue(testUser);
});

describe("GET /api/emailbison/default-field-mapping", () => {
  it("returns 401 when there is no session", async () => {
    getUser.mockResolvedValue(null);

    const response = await GET(makeRequest("?entity=people"));

    expect(response.status).toBe(401);
  });

  it("returns 400 for an invalid entity", async () => {
    const response = await GET(makeRequest("?entity=bogus"));
    expect(response.status).toBe(400);
  });

  it("defaults companyName to company_name when no candidate has a brand name (entity=people)", async () => {
    getPeopleForEmailBison.mockResolvedValue([candidate("Acme Inc", null)]);

    const response = await GET(makeRequest("?entity=people&niche=widgets"));

    expect(response.status).toBe(200);
    expect(getPeopleForEmailBison).toHaveBeenCalledTimes(1);
    expect(getPeopleForEmailBisonByCompanyFilters).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.standardFields).toEqual({
      companyName: "company_name",
      firstName: "include",
      lastName: "include",
      email: "include",
      phone: "include",
      title: "include",
      website: "include",
    });
  });

  it("defaults companyName to brand_name when any candidate has one (entity=companies)", async () => {
    getPeopleForEmailBisonByCompanyFilters.mockResolvedValue([
      candidate("Acme Inc", null),
      candidate("Acme Inc", "Acme"),
    ]);

    const response = await GET(makeRequest("?entity=companies"));

    expect(response.status).toBe(200);
    expect(getPeopleForEmailBisonByCompanyFilters).toHaveBeenCalledTimes(1);
    expect(getPeopleForEmailBison).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.standardFields.companyName).toBe("brand_name");
  });
});
