"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { motion } from "framer-motion";
import { Activity, ArrowRightLeft, Building2, ChevronRight, HelpCircle, KeyRound, LogOut, PieChart, Radio, Ticket, Upload, UserCog, Users } from "lucide-react";
import { cn } from "@/lib/utils";
import { ScaletopiaLogo } from "@/components/shared/scaletopia-logo";
import { useSession } from "@/components/dashboard/session-context";
import { logout } from "@/app/auth/actions";

const DIRECTORY_ITEMS = [
  { href: "/companies", label: "Companies", icon: Building2 },
  { href: "/people", label: "People", icon: Users },
];

const DATA_ITEMS = [
  { href: "/import", label: "Import", icon: Upload },
];

// Visible to every authenticated role — members see only their own tickets,
// admin/dev see and manage all of them (see /tickets and lib/data/tickets.ts).
const WORK_ITEMS = [
  { href: "/tickets", label: "Tickets", icon: Ticket },
  { href: "/push-activity", label: "Push Activity", icon: Radio },
  { href: "/push-history", label: "Push History", icon: ArrowRightLeft },
];

const ADMIN_ITEMS = [
  { href: "/activity", label: "Activity", icon: Activity },
  { href: "/team", label: "Team", icon: UserCog },
  { href: "/clients", label: "Clients", icon: KeyRound },
];

// Visible to every authenticated role — documentation and walkthrough videos.
const HELP_ITEMS = [
  { href: "/help", label: "Help", icon: HelpCircle },
];

function isActive(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname.startsWith(href);
}

function NavItem({
  href,
  label,
  icon: Icon,
  active,
  caret,
  onClick,
}: {
  href: string;
  label: string;
  icon: React.ComponentType<{ size?: number; className?: string }>;
  active: boolean;
  caret?: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={cn(
        "relative flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm transition-all",
        active
          ? "bg-hover font-medium text-ink"
          : "text-ink-soft hover:bg-hover hover:text-ink hover:shadow-sm hover:translate-x-0.5"
      )}
    >
      {active ? (
        <motion.span
          layoutId="sidebar-active-indicator"
          className="absolute left-0 top-1/2 h-4 w-1 -translate-y-1/2 rounded-full bg-stamp"
          transition={{ type: "spring", stiffness: 300, damping: 30 }}
        />
      ) : null}
      {caret ? <ChevronRight size={14} className="text-ink-mute" /> : <span className="w-[14px]" />}
      <motion.div
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.98 }}
        transition={{ type: "spring", stiffness: 400, damping: 25 }}
      >
        <Icon size={16} className={active ? "text-stamp" : "text-ink-soft"} />
      </motion.div>
      <span className="truncate">{label}</span>
    </Link>
  );
}

/** Shared nav content rendered by both the static desktop rail (Sidebar) and
 * the mobile drawer (MobileNav) so they can never drift out of sync. */
export function SidebarNav({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const session = useSession();
  const isAdminOrDev = session?.role === "admin" || session?.role === "dev";

  return (
    <>
      <Link href="/" onClick={onNavigate} className="flex items-center border-b border-rule px-5 py-4 hover:bg-hover/50 transition-colors">
        <ScaletopiaLogo className="h-7 w-auto text-ink" />
      </Link>

      <div className="px-3 pt-2">
        <p className="px-3 py-1 text-xs text-ink-mute">Dashboards</p>
        <nav className="mt-1 flex flex-col gap-0.5">
          <NavItem
            href="/"
            label="Overview"
            icon={PieChart}
            active={isActive(pathname, "/")}
            onClick={onNavigate}
          />
        </nav>
      </div>

      <div className="px-3 pt-3">
        <p className="px-3 py-1 text-xs text-ink-mute">Directory</p>
        <nav className="mt-1 flex flex-col gap-0.5">
          {DIRECTORY_ITEMS.map((item) => (
            <NavItem
              key={item.label}
              label={item.label}
              icon={item.icon}
              href={item.href}
              active={isActive(pathname, item.href)}
              caret
              onClick={onNavigate}
            />
          ))}
        </nav>
      </div>

      <div className="px-3 pt-3">
        <p className="px-3 py-1 text-xs text-ink-mute">Data</p>
        <nav className="mt-1 flex flex-col gap-0.5">
          {DATA_ITEMS.map((item) => (
            <NavItem
              key={item.label}
              label={item.label}
              icon={item.icon}
              href={item.href}
              active={isActive(pathname, item.href)}
              caret
              onClick={onNavigate}
            />
          ))}
        </nav>
      </div>

      <div className="px-3 pt-3">
        <p className="px-3 py-1 text-xs text-ink-mute">Work</p>
        <nav className="mt-1 flex flex-col gap-0.5">
          {WORK_ITEMS.map((item) => (
            <NavItem
              key={item.label}
              label={item.label}
              icon={item.icon}
              href={item.href}
              active={isActive(pathname, item.href)}
              caret
              onClick={onNavigate}
            />
          ))}
        </nav>
      </div>

      {isAdminOrDev && (
        <div className="px-3 pt-3">
          <p className="px-3 py-1 text-xs text-ink-mute">Admin</p>
          <nav className="mt-1 flex flex-col gap-0.5">
            {ADMIN_ITEMS.map((item) => (
              <NavItem
                key={item.label}
                label={item.label}
                icon={item.icon}
                href={item.href}
                active={isActive(pathname, item.href)}
                caret
                onClick={onNavigate}
              />
            ))}
          </nav>
        </div>
      )}

      <div className="px-3 pt-3">
        <p className="px-3 py-1 text-xs text-ink-mute">Help</p>
        <nav className="mt-1 flex flex-col gap-0.5">
          {HELP_ITEMS.map((item) => (
            <NavItem
              key={item.label}
              label={item.label}
              icon={item.icon}
              href={item.href}
              active={isActive(pathname, item.href)}
              caret
              onClick={onNavigate}
            />
          ))}
        </nav>
      </div>

      {session && (
        <div className="mt-auto border-t border-rule px-3 py-3">
          <p className="truncate px-3 pb-2 text-xs text-ink-mute" title={session.email}>
            {session.email}
          </p>
          <form action={logout}>
            <button
              type="submit"
              className="flex w-full items-center gap-2 rounded-lg px-3 py-1.5 text-sm text-ink-soft transition-colors hover:bg-hover hover:text-ink"
            >
              <LogOut size={16} className="text-ink-soft" />
              <span>Sign out</span>
            </button>
          </form>
        </div>
      )}
    </>
  );
}

export function Sidebar() {
  return (
    <aside className="hidden w-[240px] shrink-0 flex-col border-r border-rule bg-card lg:flex">
      <SidebarNav />
    </aside>
  );
}
