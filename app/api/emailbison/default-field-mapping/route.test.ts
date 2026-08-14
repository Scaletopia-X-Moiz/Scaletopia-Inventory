import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/lib/auth/dal", () => ({ getUser }));

const { getEmailBisonCompanyNameFields, getEmailBisonCompanyNameFieldsByCompanyFilters } = vi.hoisted(
  () => ({
    getEmailBisonCompanyNameFields: vi.fn(),
    getEmailBisonCompanyNameFieldsByCompanyFilters: vi.fn(),
  })
);
vi.mock("@/lib/data/people", () => ({
  getEmailBisonCompanyNameFields,
  getEmailBisonCompanyNameFieldsByCompanyFilters,
}));

const { GET } = await import("@/app/api/emailbison/default-field-mapping/route");

const testUser = { id: "user-1", email: "operator@example.com" };

function makeRequest(query: string): NextRequest {
  return new NextRequest(`http://localhost/api/emailbison/default-field-mapping${query}`);
}

// getEmailBisonCompanyNameFields / …ByCompanyFilters return the narrow
// company-name projection resolveDefaultFieldMapping reads — a flat
// { companyName, brandName } row (PushRecordCompanyNameFields), not a full
// push candidate. resolveDefaultCompanyNameSource reads brandName off the top
// level of each row, so the mock must return that flat shape.
function candidate(companyName: string | null, brandName: string | null) {
  return { companyName, brandName };
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
    getEmailBisonCompanyNameFields.mockResolvedValue([candidate("Acme Inc", null)]);

    const response = await GET(makeRequest("?entity=people&niche=widgets"));

    expect(response.status).toBe(200);
    expect(getEmailBisonCompanyNameFields).toHaveBeenCalledTimes(1);
    expect(getEmailBisonCompanyNameFieldsByCompanyFilters).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.standardFields).toEqual({
      companyName: "companyName",
      firstName: "firstName",
      lastName: "lastName",
      email: "email",
      title: "title",
    });
  });

  it("defaults companyName to brandName when any candidate has one (entity=companies)", async () => {
    getEmailBisonCompanyNameFieldsByCompanyFilters.mockResolvedValue([
      candidate("Acme Inc", null),
      candidate("Acme Inc", "Acme"),
    ]);

    const response = await GET(makeRequest("?entity=companies"));

    expect(response.status).toBe(200);
    expect(getEmailBisonCompanyNameFieldsByCompanyFilters).toHaveBeenCalledTimes(1);
    expect(getEmailBisonCompanyNameFields).not.toHaveBeenCalled();
    const body = await response.json();
    expect(body.standardFields.companyName).toBe("brandName");
  });
});
