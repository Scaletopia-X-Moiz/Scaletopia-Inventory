import Link from "next/link";
import { notFound } from "next/navigation";
import { getPersonDetail } from "@/lib/data/people";
import { getPersonEnrichmentFields } from "@/lib/data/enrichment-fields";
import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { RecordField } from "@/components/companies/record-field";
import { TagChip } from "@/components/companies/tag-chip";
import { SourceChip } from "@/components/companies/source-chip";
import { EnrichmentList } from "@/components/companies/enrichment-list";
import { ReverifyEmail } from "@/components/shared/reverify-email";
import { ReverifyPhone } from "@/components/shared/reverify-phone";
import { LinkedCompanyCard } from "@/components/people/linked-company-card";

export const dynamic = "force-dynamic";

export default async function PersonDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [person, enrichmentFields] = await Promise.all([
    getPersonDetail(id),
    getPersonEnrichmentFields(),
  ]);
  if (!person) notFound();

  // Same discovery the /people table's "Add column" picker reads, scoped by
  // key so EnrichmentList can offer "Add as column" with an identical type
  // (ticket #41, mirroring the Company detail page's ticket #39 wiring).
  const enrichmentFieldTypes = Object.fromEntries(
    enrichmentFields.fields.map((f) => [f.key, f.type])
  );

  return (
    <AppShell>
      <Topbar section="People" page="Person Record" />

      <main className="flex-1 overflow-x-hidden overflow-y-auto px-5 py-6 md:px-7">
        <div className="mx-auto flex w-full max-w-4xl min-w-0 flex-col gap-6">
          <Link href="/people" className="text-sm text-ink-soft hover:text-stamp">
            &larr; Back to people
          </Link>

          <div>
            <h1 className="text-2xl font-semibold text-ink">
              {person.fullName ?? "Unnamed person"}
            </h1>
            {person.jobTitle && <p className="text-sm text-ink-soft">{person.jobTitle}</p>}
          </div>

          <Card>
            <CardHeader>
              <CardTitle>Contact</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col">
              <RecordField label="Email">
                <ReverifyEmail
                  endpoint={`/api/people/${person.id}/reverify`}
                  email={person.email}
                  initialStatus={person.emailStatus}
                  initialVerifiedAt={person.emailVerifiedAt}
                />
              </RecordField>
              <RecordField label="Phone">
                <ReverifyPhone
                  endpoint={`/api/people/${person.id}/reverify-phone`}
                  phone={person.phone}
                  initialStatus={person.phoneStatus}
                  initialVerifiedAt={person.phoneVerifiedAt}
                  initialType={person.phoneType}
                />
              </RecordField>
              <RecordField label="Last updated">
                {person.lastUpdated
                  ? new Date(person.lastUpdated).toLocaleDateString("en-US")
                  : "—"}
              </RecordField>
              {person.linkedinUrl && (
                <RecordField label="LinkedIn">
                  <a
                    href={person.linkedinUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="text-stamp underline-offset-2 hover:underline"
                  >
                    View profile ↗
                  </a>
                </RecordField>
              )}
              {(person.city || person.state || person.country) && (
                <RecordField label="Location">
                  {[person.city, person.state, person.country].filter(Boolean).join(", ")}
                </RecordField>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Source</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {person.sources.length > 0 ? (
                  person.sources.map((id) => <SourceChip key={id} id={id} />)
                ) : (
                  <span className="text-sm text-ink-soft">—</span>
                )}
              </div>
            </CardContent>
          </Card>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-ink">Linked company</h2>
            {person.linkedCompany ? (
              <LinkedCompanyCard company={person.linkedCompany} />
            ) : person.companyName ? (
              <div className="rounded-lg border border-rule bg-card px-5 py-4">
                <p className="text-sm font-semibold text-ink">{person.companyName}</p>
                {person.domain && <p className="text-xs text-ink-soft">{person.domain}</p>}
                <p className="mt-1 text-xs italic text-ink-soft">No linked record</p>
              </div>
            ) : (
              <LinkedCompanyCard company={null} />
            )}
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-ink">Tags</h2>
            <div className="flex flex-wrap gap-2">
              {person.tags.length > 0 ? (
                person.tags.map((tag, i) => <TagChip key={`${tag}-${i}`} value={tag} />)
              ) : (
                <span className="text-sm text-ink-soft">No tags</span>
              )}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold text-ink">Enrichment data</h2>
            <EnrichmentList data={person.customData} fieldTypes={enrichmentFieldTypes} basePath="/people" />
          </section>
        </div>
      </main>
    </AppShell>
  );
}
