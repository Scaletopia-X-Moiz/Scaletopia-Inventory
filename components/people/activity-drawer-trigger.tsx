"use client";

import { useState } from "react";
import { Dialog } from "radix-ui";
import { ghlTimeAgo, formatAbsoluteDateTime } from "@/lib/utils";
import { GhlHistoryDrawer } from "@/components/people/ghl-activity";

/** The "Last activity" cell in the People table: relative time, and on click a
 * right-side drawer with that person's full GHL message history.
 *
 * The drawer UI and the (shared, cached) fetch live in ghl-activity.tsx so the
 * person detail page can reuse them. This file is just the table cell: the
 * whole cell is the trigger, and it renders nothing clickable when there is no
 * activity: an empty cell means "nothing has happened with this lead", and a
 * drawer that opens onto "No messages" is a worse answer than no drawer.
 *
 * History comes from our own database, never live from GHL — see
 * getPersonGhlMessages. */
export function ActivityDrawerTrigger({
  personId,
  personName,
  lastActivityAt,
}: {
  personId: string;
  personName: string | null;
  lastActivityAt: string | null | undefined;
}) {
  const [open, setOpen] = useState(false);

  if (!lastActivityAt) {
    // Blank, exactly like the GHL Contacts list shows for a contact with no
    // qualifying message.
    return <td className="whitespace-nowrap px-3 py-2.5 text-ink-soft" />;
  }

  return (
    <td className="p-0">
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Trigger asChild>
          <button
            type="button"
            title={formatAbsoluteDateTime(lastActivityAt)}
            className="block w-full whitespace-nowrap px-3 py-2.5 text-left text-ink underline-offset-2 hover:underline group-hover:bg-rule/30"
            aria-label={`Last activity ${ghlTimeAgo(lastActivityAt)} — open message history for ${personName ?? "this person"}`}
          >
            {ghlTimeAgo(lastActivityAt)}
          </button>
        </Dialog.Trigger>
        <GhlHistoryDrawer
          personId={personId}
          personName={personName}
          lastActivityAt={lastActivityAt}
          open={open}
        />
      </Dialog.Root>
    </td>
  );
}
