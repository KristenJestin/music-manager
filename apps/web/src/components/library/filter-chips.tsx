/**
 * The preset filters: a compact segmented group of **links**, not state.
 *
 * The Console puts every filter in the URL — `/library?filter=incomplete`, `/library/quality?
 * profile=navidrome` — for three reasons that all matter more than the convenience of
 * `useState`: a filtered view is a link you can send someone, the back button means what it
 * looks like, and a tile on the dashboard can point straight at "the nine albums below 80 %".
 * That is why these did **not** get folded into the `?f=` filter tree when the three rows of
 * the filter area were consolidated into one: a condition in the tree is removable state, and
 * a preset is an address.
 *
 * ## What changed, and why it is a group rather than six pills
 *
 * Six free-standing pills at `gap-2` are six objects competing with the search box, the
 * filter builder and two selects for one row. Drawn as one segmented control — a single
 * border, hairline dividers, no padding doubled between neighbours — they are visibly *one*
 * control that happens to have six positions, and they take about a third less width. Nothing
 * about their meaning moved: each position is still its own `<Link>` with its own href, still
 * `aria-current="page"` when it is the one in the URL, still `data-testid`'d one by one.
 *
 * ## Two facts this has to keep saying
 *
 * **A count of zero is information.** "Untagged 0" is the library telling you it has none of
 * that, which is worth knowing and is not the same as the preset not existing. Empty presets
 * are therefore demoted — the count goes to `text-fg-3` and the label to `text-fg-2` — and
 * never hidden or dropped.
 *
 * **A count can be unknown.** While a loader runs, the page renders this for real from the
 * URL and has no counts yet, so `count: null` draws a dash in a slot wide enough for three
 * digits. The chip is a control that works; the number is the one part that is still waiting,
 * and it says so quietly instead of the whole row disappearing into grey pills.
 */
import type { ReactNode } from "react";
import { Link, type LinkProps } from "@tanstack/react-router";
import { cn } from "cn";

export interface FilterChip<T extends string> {
  readonly value: T;
  readonly label: string;
  /**
   * Shown small and dim after the label.
   *
   * `undefined` for a preset with nothing to count; `null` for one whose count has not
   * arrived yet, which draws a dash and reserves the same width the number will take.
   */
  readonly count?: number | null;
  readonly title?: string;
}

export interface FilterChipsProps<T extends string> {
  readonly chips: readonly FilterChip<T>[];
  /**
   * The value currently in the URL — `string`, not `T`.
   *
   * A page may legitimately be showing a filter that has no chip: `/imports?status=paused` is
   * a valid link and lights none of them, which is the honest rendering of "you are looking at
   * something narrower than any of these buttons offers". Requiring `T` here would make that
   * URL a type error at the call site rather than a lit chip fewer on screen.
   */
  readonly active: string;
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
  /** What the group is called, for a screen reader. */
  readonly label?: string;
  /** Rendered after the group, pushed to the end of the row. */
  readonly children?: ReactNode;
  /** Defaults to the stand-alone row's `mb-3`; the one-row toolbar passes none. */
  readonly className?: string;
}

/**
 * The group on its own, with no margin and no trailing slot.
 *
 * Exported because the one-row toolbar composes it beside four other controls and must own
 * the spacing itself; `FilterChips` below is the same thing with the stand-alone row's margin
 * and the optional actions at the end.
 */
export function PresetGroup<T extends string>({
  chips,
  active,
  link,
  testId,
  label = "Preset filters",
  className,
}: Omit<FilterChipsProps<T>, "children">) {
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={testId}
      /*
       * `overflow-x-auto` rather than a wrap or an overflow menu.
       *
       * The group must never be the thing that pushes the toolbar onto a third line, and it
       * must never take a preset out of the document either — a count you cannot read without
       * opening a menu is a count nobody reads, and a link that is not in the page is one no
       * test and no screen reader can reach. Scrolling keeps every position addressable at any
       * width; on every width the Console actually supports, there is nothing to scroll.
       */
      className={cn(
        "flex min-w-0 shrink items-center overflow-x-auto rounded-lg border border-line-strong bg-surface-1",
        className,
      )}
    >
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
          // Nothing here is distinguishable by colour alone: the same fact for a screen
          // reader, which cannot see that one position is amber.
          aria-current={chip.value === active ? "page" : undefined}
          className={cn(
            "inline-flex h-7 shrink-0 items-center gap-1 border-r border-line px-2 text-xs whitespace-nowrap last:border-r-0 hover:bg-surface-2 focus-visible:z-1 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none",
            chip.value === active
              ? "bg-primary-soft text-primary"
              : chip.count === 0
                ? "text-fg-2"
                : "text-fg-1",
          )}
        >
          {chip.label}
          {chip.count === undefined ? null : (
            <span
              /*
               * A fixed slot, right-aligned. Three digits fit, so the chips beside it do not
               * shuffle sideways when `–` becomes `114` — which is the whole reason the
               * toolbar can be rendered before the loader answers.
               */
              className={cn(
                "min-w-5 text-right font-mono text-2xs tabular-nums",
                chip.value === active ? "text-primary" : "text-fg-3",
              )}
            >
              {chip.count ?? "–"}
            </span>
          )}
        </Link>
      ))}
    </div>
  );
}

/** The group as its own row: the page's `mb-3`, and whatever the page puts at the end of it. */
export function FilterChips<T extends string>({
  children,
  className = "mb-3",
  ...group
}: FilterChipsProps<T>) {
  if (children === undefined) return <PresetGroup {...group} className={className} />;
  return (
    <div className={cn("flex flex-wrap items-center gap-2", className)}>
      <PresetGroup {...group} />
      <span className="grow" />
      {children}
    </div>
  );
}
