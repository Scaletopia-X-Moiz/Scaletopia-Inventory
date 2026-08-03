import { Star } from "lucide-react";
import { ThemeToggle } from "@/components/shared/theme-toggle";
import { MobileNav } from "@/components/dashboard/mobile-nav";
import { CommandPalette } from "@/components/shared/command-palette";
import { HelpVideo } from "@/components/shared/help-video";

export function Topbar({ section = "Dashboards", page }: { section?: string; page: string }) {
  return (
    <header className="sticky top-0 z-20 flex h-[68px] shrink-0 items-center justify-between gap-3 border-b border-rule bg-paper/80 px-4 backdrop-blur-md sm:px-5 md:px-7">
      <div className="flex items-center gap-2 sm:gap-3 min-w-0">
        <MobileNav />
        <Star size={18} className="hidden text-ink-soft sm:block shrink-0" />
        <nav className="flex items-center gap-2 text-sm min-w-0">
          <span className="text-ink-soft truncate">{section}</span>
          <span className="text-ink-mute hidden sm:inline">/</span>
          <span className="font-medium text-ink truncate">{page}</span>
        </nav>
      </div>

      <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
        <CommandPalette />
        <HelpVideo />
        <ThemeToggle />
      </div>
    </header>
  );
}
