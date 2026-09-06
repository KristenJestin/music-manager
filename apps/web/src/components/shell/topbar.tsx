/**
 * The topbar: where you are, the paste box, and the two overlays.
 *
 * The paste box is the app's front door. Pressing Enter in it goes straight to the wizard with
 * the URL already in the query string, so importing an album is *paste, Enter* from any page —
 * which is the interaction the whole product exists for.
 */
import { useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { Bell, Command as CommandIcon, MonitorPlay } from "lucide-react";
import { cn } from "cn";
import { Kbd } from "#/components/kbd.tsx";
import { useShell } from "#/components/shell/shell-context.tsx";

export interface Crumb {
  readonly label: string;
  readonly to?: string;
  readonly params?: Record<string, string>;
}

export function Topbar({ crumbs }: { readonly crumbs: readonly Crumb[] }) {
  const navigate = useNavigate();
  const { setPaletteOpen, setDrawerOpen, data } = useShell();
  const [url, setUrl] = useState("");

  const submit = (event: FormEvent): void => {
    event.preventDefault();
    const trimmed = url.trim();
    if (trimmed === "") return;
    setUrl("");
    void navigate({ to: "/import/new", search: { url: trimmed } });
  };

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

      <form onSubmit={submit} className="ml-auto">
        <label
          className={cn(
            "flex h-8 w-urlbox items-center gap-1.5 rounded-md border border-line-strong bg-surface-2 pr-1.5 pl-2.5",
            "focus-within:border-primary",
          )}
        >
          <MonitorPlay className="size-4 shrink-0 text-fg-3" aria-hidden="true" />
          <span className="sr-only">Paste a YouTube URL to import</span>
          <input
            data-testid="url-paste"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
            placeholder="Paste a YouTube URL to import…"
            className="min-w-0 flex-1 bg-transparent text-xs outline-none placeholder:text-fg-3"
          />
          <Kbd>⌘K</Kbd>
        </label>
      </form>

      <button
        type="button"
        title="Activity"
        aria-label="Activity"
        data-testid="open-drawer"
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
      <button
        type="button"
        title="Command palette"
        aria-label="Command palette"
        data-testid="open-palette"
        onClick={() => {
          setPaletteOpen(true);
        }}
        className="grid size-7.5 place-items-center rounded-md border border-transparent text-fg-2 hover:border-line hover:bg-surface-2 hover:text-foreground"
      >
        <CommandIcon className="size-4" aria-hidden="true" />
      </button>
    </header>
  );
}
