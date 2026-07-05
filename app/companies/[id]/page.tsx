import Link from "next/link";
import { notFound } from "next/navigation";
import { getCompanyDetail } from "@/lib/data/companies";
import { getPeopleByCompanyId } from "@/lib/data/people";
import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordField } from "@/components/companies/record-field";
import { TagChip } from "@/components/companies/tag-chip";
import { SourceChip } from "@/components/companies/source-chip";
import { QualityBadge } from "@/components/companies/quality-badge";
import { EnrichmentList } from "@/components/companies/enrichment-list";

export const dynamic = "force-dynamic";

export default async function CompanyDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const company = await getCompanyDetail(id);
  if (!company) notFound();

  const people = await getPeopleByCompanyId(company.id);

  const location = [company.city, company.state, company.country].filter(Boolean).join(", ");

  return (
    <AppShell>
      <Topbar section="Companies" page="Company Record" />

      <main className="flex-1 overflow-x-hidden overflow-y-auto px-5 py-6 md:px-7">
        <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-6">
          <Link href="/companies" className="text-sm text-ink-soft hover:text-stamp animate-in animate-in-stagger-1">
            ← Back to companies
          </Link>

          <div className="flex flex-wrap items-start justify-between gap-4 animate-in animate-in-stagger-2">
            <div>
              <h1 className="text-2xl font-semibold text-ink">
                {company.companyName ?? "Unnamed company"}
              </h1>
              {company.domain && (
                <a
                  href={`https://${company.domain}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-ink-soft hover:text-stamp"
                >
                  {company.domain}
                </a>
              )}
              {(company.websiteUrl || company.linkedinUrl) && (
                <div className="mt-1 flex flex-wrap gap-4 text-xs">
                  {company.websiteUrl && (
                    <a
                      href={company.websiteUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-stamp underline-offset-2 hover:underline"
                    >
                      Website ↗
                    </a>
                  )}
                  {company.linkedinUrl && (
                    <a
                      href={company.linkedinUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="text-stamp underline-offset-2 hover:underline"
                    >
                      LinkedIn ↗
                    </a>
                  )}
                </div>
              )}
            </div>
            <QualityBadge tier={company.qualityTier} />
          </div>

          {company.description && (
            <p className="text-sm leading-relaxed text-ink-soft animate-in animate-in-stagger-2">
              {company.description}
            </p>
          )}

          <div className="grid gap-6 md:grid-cols-2">
            <Card className="hover-lift animate-in animate-in-stagger-3">
              <CardHeader>
                <CardTitle>Firmographics</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col">
                <RecordField label="Industry">{company.industry ?? "—"}</RecordField>
                <RecordField label="Employees">
                  {company.employeeCount?.toLocaleString("en-US") ?? "—"}
                </RecordField>
                <RecordField label="Founded">{company.foundedYear ?? "—"}</RecordField>
                <RecordField label="Revenue">
                  {company.revenue ?? "—"}
                </RecordField>
                <RecordField label="Niche">{company.niche ?? "—"}</RecordField>
                <RecordField label="Client">{company.client ?? "—"}</RecordField>
              </CardContent>
            </Card>

            <Card className="hover-lift animate-in animate-in-stagger-4">
              <CardHeader>
                <CardTitle>Contact</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col">
                <RecordField label="Phone">{company.phone ?? "—"}</RecordField>
                <RecordField label="Email">{company.email ?? "—"}</RecordField>
                <RecordField label="Location">{location || "—"}</RecordField>
                <RecordField label="Last updated">
                  {company.lastUpdated
                    ? new Date(company.lastUpdated).toLocaleDateString("en-US")
                    : "—"}
                </RecordField>
              </CardContent>
            </Card>

            <Card className="hover-lift animate-in animate-in-stagger-5">
              <CardHeader>
                <CardTitle>Delivery</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col">
                <RecordField label="Domain status">{company.domainStatus ?? "—"}</RecordField>
                <RecordField label="MX provider">{company.mxProvider ?? "—"}</RecordField>
                <RecordField label="Security gateway">
                  {company.securityGateway ?? "—"}
                </RecordField>
              </CardContent>
            </Card>

            <Card className="hover-lift animate-in animate-in-stagger-6">
              <CardHeader>
                <CardTitle>Source</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex flex-wrap gap-2">
                  {company.sources.length > 0 ? (
                    company.sources.map((sId) => <SourceChip key={sId} id={sId} />)
                  ) : (
                    <span className="text-sm text-ink-soft">—</span>
                  )}
                </div>
              </CardContent>
            </Card>
          </div>

          <section className="flex flex-col gap-2 animate-in animate-in-stagger-4">
            <h2 className="text-sm font-semibold text-ink">Enrichment data</h2>
            <EnrichmentList data={company.customData} />
          </section>

          <section className="flex flex-col gap-2 animate-in animate-in-stagger-5">
            <h2 className="text-sm font-semibold text-ink">People</h2>
            {people.length > 0 ? (
              <ul className="flex flex-col divide-y divide-rule rounded-md border border-rule">
                {people.map((person) => (
                  <li key={person.id}>
                    <Link
                      href={`/people/${person.id}`}
                      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-0.5 px-3 py-2.5 transition-smooth hover:bg-hover"
                    >
                      <div className="min-w-0">
                        <p className="truncate text-sm font-medium text-ink">
                          {person.fullName ?? "—"}
                        </p>
                        <p className="truncate text-xs text-ink-soft">{person.jobTitle ?? "—"}</p>
                      </div>
                      {(person.email || person.phone) && (
                        <div className="min-w-0 text-right text-xs text-ink-soft">
                          {person.email && <p className="truncate">{person.email}</p>}
                          {person.phone && <p className="truncate">{person.phone}</p>}
                        </div>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <span className="text-sm text-ink-soft">
                No people in our database are linked to this company yet.
              </span>
            )}
          </section>

          <section className="flex flex-col gap-2 animate-in animate-in-stagger-6">
            <h2 className="text-sm font-semibold text-ink">Tags</h2>
            <div className="flex flex-wrap gap-2">
              {company.tags.length > 0 ? (
                company.tags.map((tag, i) => <TagChip key={`${tag}-${i}`} value={tag} />)
              ) : (
                <span className="text-sm text-ink-soft">No tags</span>
              )}
            </div>
          </section>
        </div>
      </main>
    </AppShell>
  );
}
