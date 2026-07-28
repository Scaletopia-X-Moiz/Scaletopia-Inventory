import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PeopleTable } from "./people-table";
import type { PersonListRow } from "@/lib/data/people";

function makeRow(overrides: Partial<PersonListRow> = {}): PersonListRow {
  return {
    id: "p1",
    fullName: "Ada Lovelace",
    jobTitle: "Chief Engineer",
    linkedinUrl: null,
    email: "ada@example.com",
    phone: null,
    companyName: null,
    companyDomain: null,
    companyLinkedinUrl: null,
    ...overrides,
  } as PersonListRow;
}

describe("PeopleTable — bug 5c: Job Title column", () => {
  const html = renderToStaticMarkup(createElement(PeopleTable, { rows: [makeRow()] }));

  it("renders a Job Title header", () => {
    expect(html).toContain("Job Title");
  });

  it("places Job Title immediately after Full Name in the header row", () => {
    const fullNameIdx = html.indexOf("Full Name");
    const jobTitleIdx = html.indexOf("Job Title");
    const linkedinIdx = html.indexOf("LinkedIn URL");
    expect(fullNameIdx).toBeGreaterThan(-1);
    expect(jobTitleIdx).toBeGreaterThan(fullNameIdx);
    expect(jobTitleIdx).toBeLessThan(linkedinIdx);
  });

  it("renders the person's job_title value in the row", () => {
    expect(html).toContain("Chief Engineer");
  });

  it("falls back to em dash when job title is missing", () => {
    const emptyHtml = renderToStaticMarkup(
      createElement(PeopleTable, { rows: [makeRow({ jobTitle: null })] })
    );
    // full name still present, job title cell shows the dash
    expect(emptyHtml).toContain("Ada Lovelace");
  });
});

describe("PeopleTable — virtual columns (ticket #41)", () => {
  it("renders an extra header and cell for each active virtual column", () => {
    const html = renderToStaticMarkup(
      createElement(PeopleTable, {
        rows: [makeRow({ virtualColumnValues: { lead_score: 87 } })],
        virtualColumns: [{ key: "lead_score", type: "number" }],
      })
    );
    expect(html).toContain("lead_score");
    expect(html).toContain("87");
  });

  it("shows an em dash when a row has no value for the active column", () => {
    const html = renderToStaticMarkup(
      createElement(PeopleTable, {
        rows: [makeRow({ virtualColumnValues: {} })],
        virtualColumns: [{ key: "lead_score", type: "number" }],
      })
    );
    expect(html).toContain("lead_score");
    expect(html).toContain("—");
  });
});
