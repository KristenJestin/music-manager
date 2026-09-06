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
  Home,
  Inbox,
  LogOut,
  Plus,
  Settings,
  Shield,
  Sparkles,
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
  { to: "/library/quality", label: "Library quality", icon: Shield },
  { to: "/discover", label: "Discover", icon: Sparkles },
  { to: "/tools", label: "Tools & diagnostics", icon: Wrench },
  { to: "/settings", label: "Settings", icon: Settings },
];

export function CommandPalette() {
  const navigate = useNavigate();
  const { paletteOpen, setPaletteOpen, toast } = useShell();
  const [query, setQuery] = useState("");

  const close = (): void => {
    setPaletteOpen(false);
    setQuery("");
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
