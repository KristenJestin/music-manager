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
 *
 * **`⌘V` is global too, and it is the one that replaces the top bar's input.** That input was
 * the app's front door and it was worth exactly one gesture: paste, Enter. Turning the bar
 * into a button would have cost a click first, so the paste itself opens the palette with the
 * text already in it — a person who copies a YouTube link and hits `⌘V` on any page is one
 * `↵` from the import, which is one gesture *fewer* than the input ever was. It is suppressed
 * while the focus is in a field, by the same rule as the letters: pasting into the library's
 * search box must paste into the library's search box.
 */
import { useEffect, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { cn } from "cn";
import { ActivityDrawer } from "#/components/shell/activity-drawer.tsx";
import { CommandPalette } from "#/components/shell/command-palette.tsx";
import { PlayerBar } from "#/components/shell/player-bar.tsx";
import { usePlayer } from "#/components/shell/player-context.tsx";
import { Sidebar } from "#/components/shell/sidebar.tsx";
import { Toaster } from "#/components/shell/toaster.tsx";
import { Topbar, type Crumb } from "#/components/shell/topbar.tsx";
import { useShell } from "#/components/shell/shell-context.tsx";
import { useTestId } from "#/components/pending-tree.tsx";

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
  const testId = useTestId();
  const { setPaletteOpen, openPalette, setDrawerOpen, paletteOpen } = useShell();
  // The bar is fixed to the bottom of the viewport, so the page has to stop above it or the
  // last row of every table sits underneath it and cannot be clicked.
  const playing = usePlayer().current !== null;

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
    /*
     * Pasting is the gesture, so pasting is what is listened for — not `⌘V` as a keystroke.
     * The clipboard's contents only exist on the `paste` event, which is the difference
     * between opening the palette *with the link in it* and opening an empty box next to a
     * person who now has to paste again. Right-click → Paste works for the same reason.
     */
    const onPaste = (event: ClipboardEvent): void => {
      // The palette's own input is a field, so `isTyping` already covers it; this is the
      // second guard, for the instant between opening and focus landing.
      if (paletteOpen || isTyping(event.target)) return;
      const pasted = (event.clipboardData?.getData("text") ?? "").trim();
      if (pasted === "") return;
      event.preventDefault();
      openPalette(pasted);
    };

    window.addEventListener("keydown", onKey);
    document.addEventListener("paste", onPaste);
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
      document.removeEventListener("paste", onPaste);
      delete document.documentElement.dataset["shortcuts"];
    };
  }, [navigate, setPaletteOpen, openPalette, setDrawerOpen, paletteOpen]);

  return (
    <div data-testid={testId("app-shell")} className="shell-grid min-h-screen">
      <Sidebar />
      <Topbar crumbs={crumbs} />
      <main className={cn("min-w-0 px-6 pt-5", playing ? "pb-32" : "pb-16")}>{children}</main>
      <ActivityDrawer />
      <CommandPalette />
      <PlayerBar />
      <Toaster />
    </div>
  );
}
