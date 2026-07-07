import Link from "next/link";
import { Tooltip } from "radix-ui";
import { cn } from "@/lib/utils";
import type { CompanyListRow } from "@/lib/data/companies";
import { SourceChip } from "@/components/companies/source-chip";
import { PeopleDrawerTrigger } from "@/components/companies/people-drawer-trigger";
import { EmailStatusBadge } from "@/components/people/email-status-badge";
import { PhoneStatusBadge } from "@/components/people/phone-status-badge";

function formatLastUpdated(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function locationOf(row: CompanyListRow): string {
  return [row.city, row.state, row.country].filter(Boolean).join(", ") || "—";
}

const HEADERS = [
  "Company Name",
  "Domain",
  "LinkedIn",
  "Email",
  "Phone",
  "Industry",
  "Employees",
  "People",
  "Location",
  "Source",
  "Last Updated",
];

export function CompaniesTable({ rows }: { rows: CompanyListRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-rule bg-card px-6 py-12 text-center text-sm text-ink-soft">
        No companies match these filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-rule">
      <Tooltip.Provider delayDuration={200}>
      <table className="w-full min-w-[1180px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-rule bg-card">
            {HEADERS.map((h) => (
              <th
                key={h}
                className="whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold text-ink-soft"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="group border-b border-rule last:border-0">
              <td className="p-0">
                <Link
                  href={`/companies/${row.id}`}
                  className="block max-w-[260px] truncate px-3 py-2.5 font-medium text-ink group-hover:bg-rule/30"
                  title={row.companyName ?? undefined}
                >
                  {row.companyName ?? "—"}
                </Link>
              </td>
              <td className="p-0">
                {row.domain ? (
                  <a
                    href={`https://${row.domain}`}
                    target="_blank"
                    rel="noreferrer"
                    className="block whitespace-nowrap px-3 py-2.5 text-ink underline-offset-2 hover:underline group-hover:bg-rule/30"
                  >
                    {row.domain}
                  </a>
                ) : (
                  <Link
                    href={`/companies/${row.id}`}
                    className="block whitespace-nowrap px-3 py-2.5 text-ink group-hover:bg-rule/30"
                  >
                    —
                  </Link>
                )}
              </td>
              <td className="p-0">
                {row.linkedinUrl ? (
                  <a
                    href={row.linkedinUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="block whitespace-nowrap px-3 py-2.5 text-ink underline-offset-2 hover:underline group-hover:bg-rule/30"
                  >
                    LinkedIn ↗
                  </a>
                ) : (
                  <Link
                    href={`/companies/${row.id}`}
                    className="block whitespace-nowrap px-3 py-2.5 text-ink group-hover:bg-rule/30"
                  >
                    —
                  </Link>
                )}
              </td>
              <CompanyCell href={`/companies/${row.id}`}>
                <span className="inline-flex items-center gap-1.5">
                  {row.email ?? "—"}
                  <EmailStatusBadge
                    email={row.email}
                    status={row.emailStatus}
                    verifiedAt={row.emailVerifiedAt}
                  />
                </span>
              </CompanyCell>
              <CompanyCell href={`/companies/${row.id}`} mono>
                <span className="inline-flex items-center gap-1.5">
                  {row.phone ?? "—"}
                  <PhoneStatusBadge
                    phone={row.phone}
                    status={row.phoneStatus}
                    verifiedAt={row.phoneVerifiedAt}
                  />
                </span>
              </CompanyCell>
              <CompanyCell href={`/companies/${row.id}`}>{row.industry ?? "—"}</CompanyCell>
              <CompanyCell href={`/companies/${row.id}`} mono>
                {row.employeeCount?.toLocaleString("en-US") ?? "—"}
              </CompanyCell>
              <td className="p-0">
                <div className="flex items-center px-2 py-1.5">
                  <PeopleDrawerTrigger
                    companyId={row.id}
                    companyName={row.companyName}
                    count={row.peopleCount ?? 0}
                  />
                </div>
              </td>
              <CompanyCell href={`/companies/${row.id}`}>{locationOf(row)}</CompanyCell>
              <td className="p-0">
                <Link
                  href={`/companies/${row.id}`}
                  className="flex flex-wrap gap-1 px-3 py-2.5 group-hover:bg-rule/30"
                >
                  {row.sources.length > 0
                    ? row.sources.map((id) => <SourceChip key={id} id={id} />)
                    : "—"}
                </Link>
              </td>
              <CompanyCell href={`/companies/${row.id}`} mono>
                {formatLastUpdated(row.lastUpdated)}
              </CompanyCell>
            </tr>
          ))}
        </tbody>
      </table>
      </Tooltip.Provider>
    </div>
  );
}

function CompanyCell({
  href,
  mono,
  children,
}: {
  href: string;
  mono?: boolean;
  children: React.ReactNode;
}) {
  return (
    <td className="p-0">
      <Link
        href={href}
        className={cn(
          "block whitespace-nowrap px-3 py-2.5 text-ink group-hover:bg-rule/30",
          mono && "font-mono tabular-nums"
        )}
      >
        {children}
      </Link>
    </td>
  );
}
