import Link from "next/link";
import { cn } from "@/lib/utils";
import type { PersonListRow } from "@/lib/data/people";
import { SourceChip } from "@/components/companies/source-chip";
import { EmailStatusBadge } from "@/components/people/email-status-badge";
import { PhoneTypeBadge } from "@/components/people/phone-type-badge";

function formatLastUpdated(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

const HEADERS = [
  "Full Name",
  "Job Title",
  "Email",
  "Phone",
  "Company",
  "Country",
  "Source",
  "Last Updated",
];

export function PeopleTable({ rows }: { rows: PersonListRow[] }) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-rule bg-card px-6 py-12 text-center text-sm text-ink-soft">
        No people match these filters.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-rule">
      <table className="w-full min-w-[960px] border-collapse text-sm">
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
                  href={`/people/${row.id}`}
                  className="block max-w-[220px] truncate px-3 py-2.5 font-medium text-ink group-hover:bg-rule/30"
                  title={row.fullName ?? undefined}
                >
                  {row.fullName ?? "—"}
                </Link>
              </td>
              <PersonCell href={`/people/${row.id}`}>{row.jobTitle ?? "—"}</PersonCell>
              <td className="p-0">
                <Link
                  href={`/people/${row.id}`}
                  className="flex items-center gap-2 whitespace-nowrap px-3 py-2.5 group-hover:bg-rule/30"
                >
                  <span className="text-ink">{row.email ?? "—"}</span>
                  <EmailStatusBadge email={row.email} status={row.emailStatus} />
                </Link>
              </td>
              <td className="p-0">
                <Link
                  href={`/people/${row.id}`}
                  className="flex items-center gap-2 whitespace-nowrap px-3 py-2.5 group-hover:bg-rule/30"
                >
                  <span className="text-ink">{row.phone ?? "—"}</span>
                  <PhoneTypeBadge phone={row.phone} type={row.phoneType} />
                </Link>
              </td>
              <td className="p-0">
                {row.companyId ? (
                  <Link
                    href={`/companies/${row.companyId}`}
                    className="block whitespace-nowrap px-3 py-2.5 text-stamp underline-offset-2 hover:underline group-hover:bg-rule/30"
                  >
                    {row.companyName ?? "—"}
                  </Link>
                ) : (
                  <Link
                    href={`/people/${row.id}`}
                    className="block whitespace-nowrap px-3 py-2.5 text-ink group-hover:bg-rule/30"
                  >
                    {row.companyName ?? "—"}
                  </Link>
                )}
              </td>
              <PersonCell href={`/people/${row.id}`}>
                {[row.city, row.country].filter(Boolean).join(", ") || "—"}
              </PersonCell>
              <td className="p-0">
                <Link
                  href={`/people/${row.id}`}
                  className="flex flex-wrap gap-1 px-3 py-2.5 group-hover:bg-rule/30"
                >
                  {row.sources.length > 0
                    ? row.sources.map((id) => <SourceChip key={id} id={id} />)
                    : "—"}
                </Link>
              </td>
              <PersonCell href={`/people/${row.id}`} mono>
                {formatLastUpdated(row.lastUpdated)}
              </PersonCell>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PersonCell({
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
