import Link from "next/link";
import { Users, Building2 } from "lucide-react";
import type { PushJobStatus } from "@/lib/data/push-jobs";

/** "View Contacts" / "View Companies" deep links for a completed push run
 * (#123). Each is a plain link carrying the single `pushJobId` param — the
 * People/Companies tables already read filters from the URL
 * (parsePersonFilters / parseCompanyFilters), so opening one lands on the table
 * pre-filtered to exactly the records this run touched, with no bespoke state
 * plumbing. Meant to sit on a terminal job row in the Push Activity panel
 * (#122); renders nothing for a non-terminal job, since only a finished run has
 * a stable, complete `push_job_records` set to link to. */
export function PushJobDeepLinkButtons({
  jobId,
  status,
}: {
  jobId: string;
  status: PushJobStatus;
}) {
  // Terminal = anything past the two in-flight states, so a new terminal status
  // added to PushJobStatus is covered without editing this gate.
  if (status === "queued" || status === "running") return null;

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Link
        href={`/people?pushJobId=${jobId}`}
        className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-card px-2.5 py-1 text-xs font-medium text-ink transition-smooth hover:bg-hover focus-visible:ring-2 focus-visible:ring-stamp/50"
      >
        <Users size={13} />
        View Contacts
      </Link>
      <Link
        href={`/companies?pushJobId=${jobId}`}
        className="inline-flex items-center gap-1.5 rounded-md border border-rule bg-card px-2.5 py-1 text-xs font-medium text-ink transition-smooth hover:bg-hover focus-visible:ring-2 focus-visible:ring-stamp/50"
      >
        <Building2 size={13} />
        View Companies
      </Link>
    </div>
  );
}
