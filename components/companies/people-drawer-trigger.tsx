"use client";

import { useState } from "react";
import Link from "next/link";
import { Dialog, Tooltip } from "radix-ui";
import { Users, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CompanyPersonRow } from "@/lib/data/people";

interface PeopleDrawerTriggerProps {
  companyId: string;
  companyName: string | null;
  count: number;
}

/** Icon + count in the companies table that, on click, opens a side drawer
 * listing the people (from the `people` table) linked to that company via
 * company_id. The list itself is fetched on demand from
 * /api/companies/[id]/people rather than bundled into the companies list
 * payload, since most rows in a page of results will never have their
 * drawer opened. */
export function PeopleDrawerTrigger({ companyId, companyName, count }: PeopleDrawerTriggerProps) {
  const [open, setOpen] = useState(false);
  const [people, setPeople] = useState<CompanyPersonRow[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next && people === null && !loading) {
      setLoading(true);
      setError(false);
      fetch(`/api/companies/${companyId}/people`)
        .then((r) => {
          if (!r.ok) throw new Error(`${r.status}`);
          return r.json();
        })
        .then((data: { people: CompanyPersonRow[] }) => {
          setPeople(data.people);
          setLoading(false);
        })
        .catch(() => {
          setLoading(false);
          setError(true);
        });
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <Dialog.Trigger asChild>
            <button
              type="button"
              disabled={count === 0}
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-1 text-xs font-medium tabular-nums transition-smooth",
                count === 0
                  ? "cursor-default text-ink-mute/50"
                  : "text-ink-soft hover:bg-hover hover:text-stamp"
              )}
              aria-label={
                count === 0
                  ? `No people linked to ${companyName ?? "this company"}`
                  : `${count} people linked to ${companyName ?? "this company"} — open list`
              }
            >
              <Users size={13} />
              {count > 0 ? count.toLocaleString("en-US") : null}
            </button>
          </Dialog.Trigger>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            side="top"
            sideOffset={6}
            className="z-50 max-w-[220px] rounded-md border border-rule bg-popover px-2.5 py-1.5 text-xs text-ink-soft shadow-lg"
          >
            {count === 0
              ? "No people in our database are linked to this company yet."
              : `${count.toLocaleString("en-US")} people in our database are linked to this company. Click to view them.`}
            <Tooltip.Arrow className="fill-popover" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>

      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Content className="fixed inset-y-0 right-0 z-50 flex w-full max-w-sm flex-col border-l border-rule bg-card outline-none data-[state=open]:animate-drawer-in data-[state=closed]:animate-drawer-out">
          <div className="flex items-start justify-between gap-3 border-b border-rule px-5 py-4">
            <div className="min-w-0">
              <Dialog.Title className="truncate text-sm font-semibold text-ink">
                {companyName ?? "Company"}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-xs text-ink-soft">
                People linked to this company in our database
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-ink-soft hover:bg-hover"
              >
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <div className="flex-1 overflow-y-auto px-2 py-2">
            {loading ? (
              <div className="flex items-center justify-center py-10 text-ink-soft">
                <Loader2 size={16} className="animate-spin" />
              </div>
            ) : error ? (
              <p className="px-3 py-4 text-sm text-ink-soft">Failed to load people. Try again.</p>
            ) : people && people.length > 0 ? (
              <ul className="flex flex-col">
                {people.map((person) => (
                  <li key={person.id}>
                    <Link
                      href={`/people/${person.id}`}
                      className="block rounded-md px-3 py-2.5 hover:bg-hover"
                    >
                      <p className="truncate text-sm font-medium text-ink">
                        {person.fullName ?? "—"}
                      </p>
                      <p className="truncate text-xs text-ink-soft">{person.jobTitle ?? "—"}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="px-3 py-4 text-sm text-ink-soft">No people found.</p>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
