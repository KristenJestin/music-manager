/**
 * ⌘K.
 *
 * Two things live here that a menu cannot do: pasting a URL and getting an import out of it,
 * and reaching any page by typing three letters of its name. The first is why the palette
 * accepts arbitrary text at all — a YouTube link typed into a command palette should start an
 * import, not say "no results".
 */
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Activity,
  Disc3,
  Download,
  Home,
  Inbox,
  LogOut,
  Music,
  Plus,
  RotateCcw,
  Scan,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Users,
  Wrench,
  MonitorPlay,
} from "lucide-react";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "#/components/ui/command.tsx";
import { useShell } from "#/components/shell/shell-context.tsx";
import { signOut } from "#/lib/auth-client.ts";
import { retryLastFailed } from "#/server/functions/jobs.ts";
import { runYtdlpUpdate, startScan } from "#/server/functions/tools.ts";
import { verifyAll } from "#/server/functions/verify.ts";

const URL_SHAPE = /^(?:https?:\/\/|fixture:\/\/)/i;

interface Destination {
  readonly to: string;
  readonly label: string;
  readonly icon: typeof Home;
  readonly shortcut?: string;
}

const GO: readonly Destination[] = [
  { to: "/", label: "Dashboard", icon: Home },
  { to: "/import/new", label: "New import", icon: Plus, shortcut: "N" },
  { to: "/imports", label: "Jobs", icon: Activity },
  { to: "/review", label: "Review queue", icon: Inbox, shortcut: "R" },
  { to: "/library", label: "Albums", icon: Disc3 },
  { to: "/library/tracks", label: "Tracks", icon: Music },
  { to: "/library/artists", label: "Artists", icon: Users },
  { to: "/library/quality", label: "Library quality", icon: Shield },
  { to: "/discover", label: "Discover", icon: Sparkles },
  { to: "/tools", label: "Tools & diagnostics", icon: Wrench },
  { to: "/settings", label: "Settings", icon: Settings },
];

/**
 * The **action** half of the palette (`prototypes/A-console`, the ⌘K overlay).
 *
 * The palette shipped as navigation only, which is half of what a command palette is for: the
 * prototype's entries are things you *do* — update yt-dlp, scan the library, verify it against
 * Navidrome, retry the import that just failed — and each of them otherwise costs a page load
 * and a hunt for a button (DRIVE-1 §4, "Palette ⌘K").
 *
 * Each one reports what happened in a toast, because a command palette that closes silently
 * has not told you whether it worked. They are deliberately the *idempotent* ones: nothing
 * here deletes, downloads or overwrites, so a mistyped ⌘K costs nothing.
 */
interface PaletteAction {
  readonly id: string;
  readonly label: string;
  readonly icon: typeof Home;
  readonly run: () => Promise<string>;
}

export function CommandPalette() {
  const navigate = useNavigate();
  const { paletteOpen, setPaletteOpen, toast } = useShell();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const close = (): void => {
    setPaletteOpen(false);
    setQuery("");
  };

  const ACTIONS: readonly PaletteAction[] = [
    {
      id: "scan",
      label: "Scan library",
      icon: Scan,
      run: async () => {
        await startScan({ data: {} });
        return "Scan queued. Tools reports it when the worker lands.";
      },
    },
    {
      id: "ytdlp",
      label: "Update yt-dlp now",
      icon: Download,
      run: async () => {
        const result = await runYtdlpUpdate();
        return result.updated
          ? `yt-dlp updated to ${result.to ?? "the latest build"}.`
          : `yt-dlp is at ${result.from ?? "its current build"}; nothing to update.`;
      },
    },
    {
      id: "verify",
      label: "Verify library in Navidrome",
      icon: ShieldCheck,
      run: async () => {
        const report = await verifyAll({ data: {} });
        return `${String(report.verified)} album(s) compared, ${String(report.withMismatch)} with a mismatch.`;
      },
    },
    {
      id: "retry",
      label: "Retry last failed import",
      icon: RotateCcw,
      run: async () => {
        const retried = await retryLastFailed();
        if (retried === null) return "Nothing has failed. There is no import to retry.";
        void navigate({ to: "/imports/$id", params: { id: retried.importId } });
        return `Retrying from ${retried.step}.`;
      },
    },
  ];

  const act = (action: PaletteAction): void => {
    close();
    setBusy(true);
    void action.run().then(
      (message) => {
        setBusy(false);
        toast(message, "ok");
      },
      (error: unknown) => {
        setBusy(false);
        toast(error instanceof Error ? error.message : "That did not work.", "danger");
      },
    );
  };

  const isUrl = URL_SHAPE.test(query.trim());

  return (
    <CommandDialog
      open={paletteOpen}
      onOpenChange={(open: boolean) => {
        if (!open) close();
        else setPaletteOpen(true);
      }}
      title="Command palette"
      description="Paste a YouTube URL, or jump to a page."
      className="w-palette max-w-palette"
    >
      {/*
        `CommandDialog` in this shadcn style puts a dialog around its children and nothing
        else — it does not itself provide cmdk's context. Without this wrapper every command
        primitive inside throws "Cannot read properties of undefined (reading 'subscribe')",
        the render is caught by the router's error boundary, and the palette simply never
        opens. It did not, until the browser check for this phase tried it.
      */}
      <Command>
        <CommandInput
          data-testid="palette-input"
          value={query}
          onValueChange={setQuery}
          placeholder="Paste a YouTube URL, or type a page name…"
        />
        <CommandList>
          <CommandEmpty>Nothing matches. Paste a URL to import it.</CommandEmpty>
          {isUrl ? (
            <CommandGroup heading="Import">
              <CommandItem
                value={`import ${query}`}
                onSelect={() => {
                  const url = query.trim();
                  close();
                  void navigate({ to: "/import/new", search: { url } });
                }}
              >
                <MonitorPlay className="size-4" aria-hidden="true" />
                Import <span className="truncate font-mono text-2xs text-fg-2">{query.trim()}</span>
              </CommandItem>
            </CommandGroup>
          ) : null}
          <CommandGroup heading="Go to">
            {GO.map((destination) => (
              <CommandItem
                key={destination.to}
                value={destination.label}
                onSelect={() => {
                  close();
                  void navigate({ to: destination.to });
                }}
              >
                <destination.icon className="size-4" aria-hidden="true" />
                {destination.label}
                {destination.shortcut === undefined ? null : (
                  <CommandShortcut>{destination.shortcut}</CommandShortcut>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Do">
            {ACTIONS.map((action) => (
              <CommandItem
                key={action.id}
                value={action.label}
                disabled={busy}
                data-testid={`palette-action-${action.id}`}
                onSelect={() => {
                  act(action);
                }}
              >
                <action.icon className="size-4" aria-hidden="true" />
                {action.label}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandGroup heading="Session">
            <CommandItem
              value="Sign out"
              onSelect={() => {
                close();
                void signOut().then(() => {
                  toast("Signed out.");
                  void navigate({ to: "/login", search: { redirect: "/" } });
                });
              }}
            >
              <LogOut className="size-4" aria-hidden="true" />
              Sign out
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
