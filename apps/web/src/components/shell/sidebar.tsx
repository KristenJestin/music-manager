/**
 * The sidebar: three groups, live counters, the worker card.
 *
 * Library and System are present and navigable, and every entry in them lands on an honest
 * "Coming in P07" page. Hiding them until they work would mean shipping two different
 * information architectures and teaching the shape of the app twice.
 */
import { Link, type LinkProps } from "@tanstack/react-router";
import {
  Activity,
  Disc3,
  Home,
  Inbox,
  Music4,
  Plus,
  Settings,
  Shield,
  Sparkles,
  Users,
  Wrench,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { cn } from "cn";
import { Kbd } from "#/components/kbd.tsx";
import { WorkerCard } from "#/components/shell/worker-card.tsx";
import { useShell } from "#/components/shell/shell-context.tsx";

interface NavEntry {
  readonly to: LinkProps["to"];
  readonly label: string;
  readonly icon: LucideIcon;
  readonly shortcut?: string;
  readonly counter?: "review" | "progress" | "failed";
  readonly exact?: boolean;
}

interface NavGroup {
  readonly heading: string;
  readonly entries: readonly NavEntry[];
}

const GROUPS: readonly NavGroup[] = [
  {
    heading: "Overview",
    entries: [
      { to: "/", label: "Dashboard", icon: Home, exact: true },
      { to: "/import/new", label: "Import", icon: Plus, shortcut: "N" },
      { to: "/imports", label: "Jobs", icon: Activity, counter: "progress" },
      { to: "/review", label: "Review", icon: Inbox, shortcut: "R", counter: "review" },
    ],
  },
  {
    heading: "Library",
    entries: [
      { to: "/library", label: "Albums", icon: Disc3, exact: true },
      { to: "/library/tracks", label: "Tracks", icon: Music4 },
      { to: "/library/artists", label: "Artists", icon: Users },
      { to: "/discover", label: "Discover", icon: Sparkles },
      { to: "/library/quality", label: "Quality", icon: Shield },
    ],
  },
  {
    heading: "System",
    entries: [
      { to: "/tools", label: "Tools", icon: Wrench },
      { to: "/settings", label: "Settings", icon: Settings },
    ],
  },
];

export function Sidebar() {
  const { data } = useShell();
  const counters = {
    review: data?.needsReview ?? 0,
    progress: data?.inProgress ?? 0,
    failed: data?.failed ?? 0,
  };

  return (
    <aside className="sticky top-0 row-span-2 flex h-screen flex-col border-r border-line bg-surface-1">
      <div className="flex h-topbar items-center gap-2.5 border-b border-line px-3.5 font-semibold">
        <span className="grid size-5.5 place-items-center rounded-md bg-primary text-primary-foreground">
          <Music4 className="size-3.5" aria-hidden="true" />
        </span>
        Music Manager
        <span className="ml-auto font-mono text-3xs text-fg-3">v{data?.version ?? "—"}</span>
      </div>

      <nav className="flex flex-col gap-0.5 px-2 py-2.5" aria-label="Main">
        {GROUPS.map((group) => (
          <div key={group.heading} className="contents">
            <h3 className="px-2 pt-3 pb-1 text-2xs font-semibold tracking-wider text-fg-1 uppercase">
              {group.heading}
            </h3>
            {group.entries.map((entry) => {
              const count = entry.counter === undefined ? 0 : counters[entry.counter];
              return (
                <Link
                  key={entry.label}
                  to={entry.to}
                  activeOptions={{ exact: entry.exact ?? false }}
                  className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-fg-1 hover:bg-surface-2 hover:text-foreground"
                  activeProps={{
                    className: "bg-surface-3 text-foreground inset-shadow-nav",
                  }}
                >
                  <entry.icon className="size-4 shrink-0" aria-hidden="true" />
                  <span>{entry.label}</span>
                  {count > 0 ? (
                    <span
                      className={cn(
                        "ml-auto rounded-xl px-1.5 font-mono text-2xs",
                        entry.counter === "review"
                          ? "bg-warn-soft text-warn"
                          : "bg-muted-soft text-fg-2",
                      )}
                    >
                      {count}
                    </span>
                  ) : entry.shortcut === undefined ? null : (
                    <Kbd className="ml-auto">{entry.shortcut}</Kbd>
                  )}
                </Link>
              );
            })}
          </div>
        ))}
      </nav>

      <div className="mt-auto border-t border-line p-2.5">
        <WorkerCard />
      </div>
    </aside>
  );
}
