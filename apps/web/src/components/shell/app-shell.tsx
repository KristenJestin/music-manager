/**
 * The Console frame, and the keyboard.
 *
 * Four global shortcuts, and they are global on purpose (`docs/07-ui.md`): `⌘K` opens the
 * palette, `N` starts an import, `R` opens Review, `Escape` closes whatever is open. All four
 * are suppressed while the focus is in a field — a keyboard-first app that eats the letter `n`
 * out of a search box is a keyboard-hostile app.
 *
 * `↵` is not global: it means "take the preselected answer", which only means something on a
 * page that *has* one, so `/review/:id` and the wizard bind it themselves.
 */
import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { ActivityDrawer } from "#/components/shell/activity-drawer.tsx";
import { CommandPalette } from "#/components/shell/command-palette.tsx";
import { Sidebar } from "#/components/shell/sidebar.tsx";
import { Toaster } from "#/components/shell/toaster.tsx";
import { Topbar, type Crumb } from "#/components/shell/topbar.tsx";
import { useShell } from "#/components/shell/shell-context.tsx";

/** True when the keystroke belongs to whatever the user is typing into. */
function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function AppShell({
  crumbs,
  children,
}: {
  readonly crumbs: readonly Crumb[];
  readonly children: ReactNode;
}) {
  const navigate = useNavigate();
  const { setPaletteOpen, setDrawerOpen, paletteOpen } = useShell();

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
        return;
      }
      if (event.key === "Escape") {
        setPaletteOpen(false);
        setDrawerOpen(false);
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (event.key === "n" || event.key === "N") {
        event.preventDefault();
        void navigate({ to: "/import/new" });
      }
      if (event.key === "r" || event.key === "R") {
        event.preventDefault();
        void navigate({ to: "/review" });
      }
    };
    window.addEventListener("keydown", onKey);
    /*
     * Say so on the document, for anything that needs to know the keyboard is live.
     *
     * The shortcuts are attached by this effect, and a key pressed before it runs is simply
     * lost — an unlucky millisecond for a person, every run for a test runner. A React state
     * flag would be set one commit *earlier* than the listener and so would lie by exactly the
     * window that matters; writing the attribute from inside the effect cannot.
     */
    document.documentElement.dataset["shortcuts"] = "on";
    return () => {
      window.removeEventListener("keydown", onKey);
      delete document.documentElement.dataset["shortcuts"];
    };
  }, [navigate, setPaletteOpen, setDrawerOpen, paletteOpen]);

  return (
    <div data-testid="app-shell" className="shell-grid min-h-screen">
      <Sidebar />
      <Topbar crumbs={crumbs} />
      <main className="min-w-0 px-6 pt-5 pb-16">{children}</main>
      <ActivityDrawer />
      <CommandPalette />
      <Toaster />
    </div>
  );
}
