/**
 * A row of filter chips that are links, not state.
 *
 * The Console puts every filter in the URL — `/library?filter=incomplete`, `/library/quality?
 * profile=navidrome` — for three reasons that all matter more than the convenience of
 * `useState`: a filtered view is a link you can send someone, the back button means what it
 * looks like, and a tile on the dashboard can point straight at "the nine albums below 80 %".
 *
 * P06's `/imports` page grew this pattern inline; three more pages need it, so it lives here
 * now and `/imports` keeps its own copy until somebody has a reason to touch that file.
 */
import type { ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { cn } from "cn";

export interface FilterChip<T extends string> {
  readonly value: T;
  readonly label: string;
  /** Shown small and dim after the label. Omit for a chip with nothing to count. */
  readonly count?: number;
  readonly title?: string;
}

export interface FilterChipsProps<T extends string> {
  readonly chips: readonly FilterChip<T>[];
  readonly active: T;
  /**
   * Where one chip points, as `<Link>` props.
   *
   * The whole `LinkProps` rather than a `to` plus a search object: TanStack types `search`
   * against the specific route named by `to`, so splitting them here would mean either losing
   * that check or writing a generic signature nobody can read. The caller passes both
   * together and keeps the type safety at the call site, where it is useful.
   */
  readonly link: (value: T) => LinkProps;
  readonly testId?: string;
  readonly children?: ReactNode;
}

export function FilterChips<T extends string>({
  chips,
  active,
  link,
  testId,
  children,
}: FilterChipsProps<T>) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2" data-testid={testId}>
      {chips.map((chip) => (
        <Link
          key={chip.value}
          {...link(chip.value)}
          title={chip.title}
          data-testid={`${testId ?? "filter"}-${chip.value}`}
          /*
           * Which chip is on, said out loud.
           *
           * It is otherwise only knowable from the colour, or from guessing how the router
           * spells the URL — and the guess is wrong: TanStack keeps a search value that
           * equals its zod default, so "all" reads `?filter=all&profile=global` and not the
           * bare path a test once waited sixty seconds for. The active chip is the fact; the
           * query string is one of several encodings of it.
           */
          data-active={chip.value === active ? "true" : "false"}
          className={cn(
            "inline-flex h-6 items-center gap-1.5 rounded-xl border border-line-strong bg-surface-2 px-2.5 text-xs text-fg-1 hover:bg-surface-3",
            chip.value === active && "border-primary bg-primary-soft text-primary",
          )}
        >
          {chip.label}
          {chip.count === undefined ? null : (
            <span className="font-mono text-2xs text-fg-3">{chip.count}</span>
          )}
        </Link>
      ))}
      {children === undefined ? null : (
        <>
          <span className="grow" />
          {children}
        </>
      )}
    </div>
  );
}
