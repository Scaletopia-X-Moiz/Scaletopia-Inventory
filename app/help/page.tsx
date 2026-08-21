import { AppShell } from "@/components/dashboard/app-shell";
import { Topbar } from "@/components/dashboard/topbar";
import { HelpView } from "./help-view";

export const metadata = { title: "Help · Scaletopia Databank" };

export default function HelpPage() {
  return (
    <AppShell>
      <Topbar section="Pages" page="Help" />
      <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 sm:px-6 lg:px-8">
        <div className="mx-auto max-w-3xl">
          <h1 className="mb-1 text-xl font-semibold text-ink">Help &amp; guides</h1>
          <p className="mb-6 text-sm text-ink-soft">
            Step-by-step guides and walkthrough videos. Expand a topic to read the
            steps and watch the video.
          </p>
          <HelpView />
        </div>
      </main>
    </AppShell>
  );
}
