"use client";

import Link from "next/link";
import { Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import type { PersonListRow } from "@/lib/data/people";
import type { ActiveVirtualColumn } from "@/lib/data/virtual-columns";
import { virtualColumnIdentity } from "@/lib/data/virtual-columns";
import { EmailStatusBadge } from "@/components/people/email-status-badge";
import { PhoneStatusBadge } from "@/components/people/phone-status-badge";
import { formatValue } from "@/components/companies/enrichment-list";
import { mxProviderLabel } from "@/lib/data/mx-provider";
import { ScrollableTable } from "@/components/shared/scrollable-table";
import { ActivityDrawerTrigger } from "@/components/people/activity-drawer-trigger";

function formatLastUpdated(value: string | null): string {
  if (!value) return "—";
  return new Date(value).toLocaleDateString("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

/** Row selection, owned by PeopleResultsClient (see that file for why it is
 * cleared on a filter change but kept across pages). Optional: the table
 * renders without a checkbox column when no selection is wired. */
export interface PeopleTableSelection {
  selectedIds: ReadonlySet<string>;
  toggleRow: (id: string, selected: boolean) => void;
  /** Selects/deselects every row currently rendered — the page, not the
   * filtered total, which the client has never seen the ids of. */
  togglePage: (selected: boolean) => void;
}

const HEADERS = [
  "Full Name",
  "Job Title",
  "LinkedIn URL",
  "Email",
  "ESP",
  "Phone",
  "Company",
  "Company Domain",
  "Company LinkedIn URL",
  // GHL last activity, rendered as truncated relative time and clickable for
  // the full message history (docs/features/ghl-last-activity/handoff.md).
  // Sits before Last Updated so the two date columns read together.
  "Last activity",
  "Last Updated",
];

export function PeopleTable({
  rows,
  virtualColumns = [],
  selection,
}: {
  rows: PersonListRow[];
  virtualColumns?: ActiveVirtualColumn[];
  selection?: PeopleTableSelection;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-rule bg-card px-6 py-12 text-center text-sm text-ink-soft">
        No people match these filters.
      </div>
    );
  }

  const selectedOnPage = selection
    ? rows.reduce((n, row) => (selection.selectedIds.has(row.id) ? n + 1 : n), 0)
    : 0;

  return (
    <ScrollableTable>
      <table className="w-full min-w-[1180px] border-collapse text-sm">
        <thead>
          <tr className="border-b border-rule bg-card">
            {selection && (
              <th scope="col" className="w-10 px-3 py-2.5">
                <SelectCheckbox
                  checked={selectedOnPage > 0 && selectedOnPage === rows.length}
                  indeterminate={selectedOnPage > 0 && selectedOnPage < rows.length}
                  onChange={(next) => selection.togglePage(next)}
                  label="Select every person on this page"
                />
              </th>
            )}
            {HEADERS.map((h) => (
              <th
                key={h}
                className="whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold text-ink-soft"
              >
                {h}
              </th>
            ))}
            {virtualColumns.map((col) => (
              <th
                key={virtualColumnIdentity(col.source, col.key, "person")}
                className="whitespace-nowrap px-3 py-2.5 text-left text-xs font-semibold text-stamp"
              >
                <span className="inline-flex items-center gap-1">
                  {col.source === "company" && <Building2 size={14} className="text-ink-soft" />}
                  {col.key}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="group border-b border-rule last:border-0">
              {selection && (
                // Deliberately outside the <Link> wrapper every other cell
                // uses: a checkbox nested in a link would navigate to the
                // person on click. stopPropagation guards the cell against
                // any row-level handler added later.
                <td className="px-3 py-2.5" onClick={(e) => e.stopPropagation()}>
                  <SelectCheckbox
                    checked={selection.selectedIds.has(row.id)}
                    onChange={(next) => selection.toggleRow(row.id, next)}
                    label={`Select ${row.fullName ?? "this person"}`}
                  />
                </td>
              )}
              <td className="p-0">
                <Link
                  href={`/people/${row.id}`}
                  className="block max-w-[220px] truncate px-3 py-2.5 font-medium text-ink group-hover:bg-rule/30"
                  title={row.fullName ?? undefined}
                >
                  {row.fullName ?? "—"}
                </Link>
              </td>
              <td className="max-w-[220px] truncate px-3 py-2.5 text-ink-soft" title={row.jobTitle ?? undefined}>
                {row.jobTitle ?? "—"}
              </td>
              <ExternalLinkCell url={row.linkedinUrl} />
              <PersonCell href={`/people/${row.id}`}>
                <span className="inline-flex items-center gap-1.5">
                  {row.email ?? "—"}
                  <EmailStatusBadge
                    email={row.email}
                    status={row.emailStatus}
                    verifiedAt={row.emailVerifiedAt}
                  />
                </span>
              </PersonCell>
              <PersonCell href={`/people/${row.id}`}>{row.mxProvider ? mxProviderLabel(row.mxProvider) : "—"}</PersonCell>
              <PersonCell href={`/people/${row.id}`} mono>
                <span className="inline-flex items-center gap-1.5">
                  {row.phone ?? "—"}
                  <PhoneStatusBadge
                    phone={row.phone}
                    status={row.phoneStatus}
                    verifiedAt={row.phoneVerifiedAt}
                  />
                </span>
              </PersonCell>
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
              <ActivityDrawerTrigger
                personId={row.id}
                personName={row.fullName}
                lastActivityAt={row.lastActivityAt}
              />
              <PersonCell href={`/people/${row.id}`} mono>
                {formatLastUpdated(row.lastUpdated)}
              </PersonCell>
              {virtualColumns.map((col) => {
                const value = row.virtualColumnValues?.[virtualColumnIdentity(col.source, col.key, "person")];
                return (
                  <PersonCell key={virtualColumnIdentity(col.source, col.key, "person")} href={`/people/${row.id}`}>
                    {value == null ? "—" : formatValue(value)}
                  </PersonCell>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </ScrollableTable>
  );
}

/** `indeterminate` has no HTML attribute — it is a DOM property only, so it is
 * set through a ref. aria-checked="mixed" carries the same state to assistive
 * tech, which does not read the property. */
function SelectCheckbox({
  checked,
  indeterminate = false,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  return (
    <input
      type="checkbox"
      checked={checked}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      onChange={(e) => onChange(e.target.checked)}
      onClick={(e) => e.stopPropagation()}
      aria-label={label}
      aria-checked={indeterminate ? "mixed" : checked}
      className="size-3.5 cursor-pointer accent-stamp align-middle"
    />
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
        className="block whitespace-nowrap px-3 py-2.5 text-ink underline-offset-2 hover:underline"
      >
        LinkedIn ↗
      </a>
    </td>
  );
}
