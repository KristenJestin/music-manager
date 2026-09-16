/**
 * One row for everything that filters.
 *
 * ## The complaint
 *
 * `/library` used to spend three lines on one idea. A search box on the first, a `+ Filter`
 * button on the second, a row of preset pills on the third — `All 114 · Incomplete 6 ·
 * Untagged 0 · No cover 0 · YouTube cover 2 · Behind schema 0`. Every one of those is a filter,
 * and the reader had to learn three separate places to look before touching any of them. Worse,
 * all three were inside the route's `pendingComponent`, so a navigation replaced the lot with
 * grey blocks even though not one of them depends on the loader.
 *
 * ## The row
 *
 * ```
 * [ search, growing ] [ condition chips ] [ + Filter ]        [ presets ] [ sort ] [ profile ]
 * ```
 *
 * Left to right in the order someone reaches for them. The search box is first and takes all
 * the slack, because it is what a person types without thinking. The conditions they built sit
 * next to the builder that makes more of them. The presets, the sort and the profile are one
 * block at the end — chosen occasionally, and stable enough to be somewhere you look rather
 * than somewhere you scan.
 *
 * It wraps onto exactly two lines and never three: the row has three participants, the search
 * grows to eat the slack on line one, and the trailing block moves as a unit when there is no
 * room for it. (Enough hand-built conditions will of course wrap the chips themselves, but
 * that is the reader's own doing and each chip says what it is.)
 *
 * ## Two arrangements that were tried and rejected
 *
 * **Presets behind a "View" dropdown.** The narrowest possible row: one trigger reading
 * "Incomplete 6", everything else a click away. Rejected because it throws away the counts,
 * and the counts are the reason the presets earn their space — `Untagged 0` is the library
 * telling you it has none of that, and a number nobody can see without opening a menu is a
 * number nobody reads. It also puts six links behind a button, which is six addresses that
 * stop being visible as addresses.
 *
 * **Presets folded into the `?f=` tree.** Tempting, because it makes one mental model out of
 * two: everything in the row becomes a removable condition. Rejected because it quietly breaks
 * what a preset *is*. `/library?filter=incomplete` is an address — the dashboard tile links to
 * it, the owner has it in a bookmark, the back button steps through it — and turning it into
 * `?f=<encoded>` either breaks those links or demands a translation layer that has to keep
 * both spellings alive forever. It would also make a preset silently removable in a way that
 * leaves no trace of which preset it had been. The presets are links; they stayed links, at the
 * same URLs they had.
 *
 * ## What it must not do
 *
 * Nothing in here reads the loader. Everything comes from `Route.useSearch()`, which is why a
 * page can render this for real while its data is still in flight and hand the counts in later
 * as `null`. Keep it that way: a prop that needs the loader belongs in `children`, not here.
 */
import type { ReactNode } from "react";
import { useState } from "react";
import { cn } from "cn";
import { SearchInput } from "#/components/search-input.tsx";
import { FilterConditions } from "#/components/library/filter-bar.tsx";
import { PresetGroup, type FilterChip } from "#/components/library/filter-chips.tsx";
import type { FilterFieldSet } from "#/lib/filters/index.ts";
import type { LinkProps } from "@tanstack/react-router";

export interface FilterToolbarProps<T extends string> {
  /** The free-text box. `value` is what the URL holds; `onSubmit` fires on Enter and clear. */
  readonly search?: {
    readonly value: string;
    readonly onSubmit: (value: string) => void;
    readonly label: string;
    readonly placeholder?: string;
    readonly testId?: string;
  };
  /** The `?f=` tree: the chips already built, and the `+ Filter` popover that builds more. */
  readonly conditions?: {
    readonly fields: FilterFieldSet;
    readonly value: string;
    readonly onChange: (next: string) => void;
    readonly testId?: string;
  };
  /** The preset links. `count: null` on any chip whose number has not arrived yet. */
  readonly presets?: {
    readonly chips: readonly FilterChip<T>[];
    readonly active: string;
    readonly link: (value: T) => LinkProps;
    readonly testId?: string;
  };
  /** The trailing controls — sort, profile — kept in the block at the end of the row. */
  readonly children?: ReactNode;
  readonly className?: string;
}

/**
 * The search box, holding a draft until Enter.
 *
 * The draft re-syncs when the URL's value changes underneath it (the "adjust state while
 * rendering" pattern, not an effect). That matters now that a preset is one click away in the
 * same row: clicking `All` clears `?q=` and the box has to empty with it, rather than keeping
 * a word that is no longer filtering anything.
 */
function ToolbarSearch({
  search,
}: {
  readonly search: NonNullable<FilterToolbarProps<string>["search"]>;
}) {
  const [draft, setDraft] = useState(search.value);
  const [applied, setApplied] = useState(search.value);
  if (applied !== search.value) {
    setApplied(search.value);
    setDraft(search.value);
  }

  return (
    <SearchInput
      data-testid={search.testId}
      className="min-w-56 grow basis-56"
      label={search.label}
      placeholder={search.placeholder}
      value={draft}
      onValueChange={setDraft}
      // Takes the value rather than reading `draft`: the clear button changes the state and
      // submits in the same tick, so the state it would read is still the old one.
      onSubmit={search.onSubmit}
    />
  );
}

export function FilterToolbar<T extends string>({
  search,
  conditions,
  presets,
  children,
  className,
}: FilterToolbarProps<T>) {
  const trailing = presets !== undefined || children !== undefined;
  return (
    <div
      /*
       * Named once, so a screen reader can jump to "the filters" rather than meeting a search
       * box, a group of chips, a group of links and two selects as four unrelated things in a
       * row. `search` is a landmark and means *search functionality*, so it is only honest
       * when there is a box to type in; `/imports` and `/library/quality` have presets and a
       * select and no free text, and they get a plain group.
       */
      role={search === undefined ? "group" : "search"}
      aria-label="Filter and sort"
      data-slot="filter-toolbar"
      className={cn("mb-3 flex flex-wrap items-center gap-2", className)}
    >
      {search === undefined ? null : <ToolbarSearch search={search} />}
      {conditions === undefined ? null : (
        <FilterConditions
          fields={conditions.fields}
          value={conditions.value}
          onChange={conditions.onChange}
          testId={conditions.testId}
        />
      )}
      {trailing ? (
        <div className="flex min-w-0 shrink items-center gap-2">
          {presets === undefined ? null : (
            <PresetGroup
              chips={presets.chips}
              active={presets.active}
              link={presets.link}
              testId={presets.testId}
            />
          )}
          {children}
        </div>
      ) : null}
    </div>
  );
}
