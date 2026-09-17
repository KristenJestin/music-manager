/**
 * The topbar: where you are, the way in, and the two overlays.
 *
 * The way in used to be an input that accepted a YouTube URL and nothing else. It is a button
 * onto the command palette now, because the string somebody has in the clipboard is as often a
 * MusicBrainz link, an album name or an artist — and a box that answers "no results" to three
 * of the four is a box you have to know the rules of before you can use it. The palette
 * decides what the string is; this is one of its three doors, with ⌘K and ⌘V.
 */
import { type ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Bell, Command as CommandIcon, Search } from "lucide-react";
import { cn } from "cn";
import { Kbd } from "#/components/kbd.tsx";
import { useShell } from "#/components/shell/shell-context.tsx";
import { useHydrated } from "#/hooks/use-hydrated.ts";
import { useTestId } from "#/components/pending-tree.tsx";

export interface Crumb {
  readonly label: string;
  readonly to?: string;
  readonly params?: Record<string, string>;
}

export function Topbar({ crumbs }: { readonly crumbs: readonly Crumb[] }) {
  const testId = useTestId();
  const { openPalette, setDrawerOpen, data } = useShell();
  /*
   * The two overlay buttons are pure React state, so a click before hydration does exactly
   * nothing — silently. `useHydrated` is the pattern the forms already use for this: the
   * control is disabled until it can work, which tells a person the truth and makes
   * Playwright's `click()` wait for hydration without needing to know that is what it is
   * waiting for. The E2E suite met the untreated version as a drawer that never opened.
   */
  const hydrated = useHydrated();

  return (
    <header className="sticky top-0 z-20 flex h-topbar items-center gap-3 border-b border-line bg-background/85 px-4 backdrop-blur-md">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-fg-2">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          const content: ReactNode = last ? (
            <b className="font-medium text-foreground">{crumb.label}</b>
          ) : crumb.to === undefined ? (
            crumb.label
          ) : (
            <Link to={crumb.to} params={crumb.params ?? {}} className="hover:text-foreground">
              {crumb.label}
            </Link>
          );
          return (
            <span key={`${crumb.label}-${String(index)}`} className="flex items-center gap-1.5">
              {content}
              {last ? null : <span className="text-fg-3">/</span>}
            </span>
          );
        })}
      </nav>

      {/*
        The front door, and it is a *button* now.

        It was an input that took one thing — a YouTube URL — and answered "no" to everything
        else somebody might have in the clipboard: a MusicBrainz link, an album name, an
        artist. One box that accepts one syntax is a box you have to already know the rules
        of. Pressing this opens the palette, which decides what the string is and offers the
        right things; ⌘K opens the same palette, and ⌘V anywhere on the page opens it with the
        clipboard already in it (`app-shell.tsx`). So pasting a link is still paste-then-Enter
        and never costs a gesture more than it used to.
      */}
      <button
        type="button"
        data-testid={testId("open-palette")}
        disabled={!hydrated}
        onClick={() => {
          openPalette();
        }}
        className={cn(
          "ml-auto flex h-8 w-urlbox items-center gap-1.5 rounded-md border border-line-strong bg-surface-2 pr-1.5 pl-2.5 text-left",
          "hover:border-primary disabled:opacity-60",
        )}
      >
        <Search className="size-4 shrink-0 text-fg-3" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate text-xs text-fg-3">
          Search, or paste a link or an MBID…
        </span>
        {/*
         * The Apple command glyph on a Windows machine is a rune, not a hint (owner review
         * A4/B9), so the modifier is spelled out for everyone whose keyboard does not have
         * that key. The glyph stays for everyone whose does.
         */}
        <Kbd>
          <CommandIcon className="inline size-3 align-middle" aria-hidden="true" />
          <span className="sr-only">Command or Control</span> K
        </Kbd>
      </button>

      <button
        type="button"
        title="Activity"
        aria-label="Activity"
        data-testid={testId("open-drawer")}
        disabled={!hydrated}
        onClick={() => {
          setDrawerOpen(true);
        }}
        className="relative grid size-7.5 place-items-center rounded-md border border-transparent text-fg-2 hover:border-line hover:bg-surface-2 hover:text-foreground"
      >
        <Bell className="size-4" aria-hidden="true" />
        {(data?.needsReview ?? 0) > 0 ? (
          <span className="absolute top-1 right-1 size-1.5 rounded-full bg-danger" />
        ) : null}
      </button>
    </header>
  );
}
