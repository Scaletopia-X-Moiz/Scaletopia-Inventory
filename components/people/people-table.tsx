import Link from "next/link";
import { cn } from "@/lib/utils";
import type { PersonListRow } from "@/lib/data/people";

const HEADERS = [
  "Full Name",
  "LinkedIn URL",
  "Email",
  "Company",
  "Company Domain",
  "Company LinkedIn URL",
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
              <ExternalLinkCell url={row.linkedinUrl} />
              <PersonCell href={`/people/${row.id}`}>{row.email ?? "—"}</PersonCell>
              <td className="p-0">
                {row.companyId ? (
                  <Link
                    href={`/companies/${row.companyId}`}
                    className="block whitespace-nowrap px-3 py-2.5 text-ink underline-offset-2 hover:underline group-hover:bg-rule/30"
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
              <PersonCell href={`/people/${row.id}`}>{row.domain ?? "—"}</PersonCell>
              <ExternalLinkCell url={row.companyLinkedinUrl} />
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

function ExternalLinkCell({ url }: { url: string | null }) {
  if (!url) {
    return <td className="whitespace-nowrap px-3 py-2.5 text-ink-soft">—</td>;
  }
  return (
    <td className="p-0">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block max-w-[260px] truncate whitespace-nowrap px-3 py-2.5 text-ink underline-offset-2 hover:underline"
      >
        {url}
      </a>
    </td>
  );
}
