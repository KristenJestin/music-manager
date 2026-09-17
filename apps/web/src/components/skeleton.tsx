/**
 * The skeleton vocabulary every route's `pendingComponent` is drawn from.
 *
 * Why this exists at all: TanStack Router renders a route's `component` only once its loader
 * has resolved, and until then it leaves **the page you just left** on the glass. On a library
 * of 5 000 tracks that is seconds of looking at the wrong screen with no sign the click landed.
 * A `pendingComponent` per route paints the target page's own shape immediately instead; this
 * module is the set of shapes, so that thirty pending components agree on one tint, one radius
 * and one accessibility contract rather than inventing thirty.
 *
 * Four rules hold for everything here.
 *
 * **Only the data waits.** A page's toolbar — the search box, the filter builder, the preset
 * links, the sort and profile selects — is built from the URL and not from the loader, so it
 * renders for real while the loader runs and is never drawn as a grey block. What is left for
 * this module is the part that genuinely has no value yet: the grid, the table body, the
 * tiles, the detail cards. There is deliberately no `SkeletonToolbar` here any more.
 *
 * **The shape must be the one that lands, to the pixel.** A skeleton whose grid has four
 * columns in front of a page that renders six is its own jank. So is a 14 px bar standing in
 * for a 17.4 px line of `text-xs`, which is what three of these composites used to do and what
 * made the album grid shift a row down when the covers arrived. Placeholders for text go
 * through `SkeletonLine`, which occupies one real line box of a named type scale; the table
 * skeleton is built from the *same* `Table` primitives and paddings as `DataTable`.
 *
 * **Still by default, and never for `prefers-reduced-motion`.** Large plates (covers, cards,
 * frames) carry a quiet tint and do not move; only the small bars breathe, on the shallow
 * `animate-skeleton` rather than Tailwind's own `animate-pulse`. The motion is behind
 * `motion-safe:`, so a reader who asked for stillness gets the tint and nothing moving. That
 * is a variant rather than a media query in `styles.css` because `components/ui/skeleton.tsx`
 * is shadcn's file and must stay re-addable with the CLI.
 *
 * **One announcement, not fifty rows.** `SkeletonPage` holds a single visually hidden
 * sentence, and that span is the live region; every grey block is `aria-hidden` on its own, so
 * a screen reader hears "Loading the album grid…" once, reads the real toolbar as the content
 * it is, and recites nothing at all of the forty placeholder cells.
 *
 * **And its controls are the second copy of themselves.** A route's pending tree and its
 * settled tree both render the page's real toolbar, and React keeps both mounted across a
 * re-suspend. `SkeletonPage` therefore wraps its children in `PendingTree`, which suffixes
 * every `data-testid` under it: the settled page keeps `library-search`, the copy in here is
 * `library-search-pending`, and a query for the page's controls names one element at every
 * instant of the transition. `components/pending-tree.tsx` is the whole of that argument.
 */
import type { ReactNode } from "react";
import { cn } from "cn";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "#/components/ui/table.tsx";
import { Skeleton as Primitive } from "#/components/ui/skeleton.tsx";
import { PendingTree } from "#/components/pending-tree.tsx";

/**
 * One grey block, in one of two weights.
 *
 * `bar` — the default — is a short placeholder standing in for a line of text or a control.
 * It is `bg-skeleton` and it breathes: `animate-none motion-safe:animate-skeleton`, where the
 * first token wins over the primitive's `animate-pulse` in `cn`'s merge and the second puts
 * the motion back only inside `@media (prefers-reduced-motion: no-preference)`.
 *
 * `plate` is everything large: a cover, a card, a table frame. It is a step quieter
 * (`bg-skeleton-plate`) and it does **not** move. That split is the answer to the owner
 * calling the old skeleton violent — the thing that read as aggressive was not the pulse
 * itself but a full screen of surfaces pulsing in unison. Now the page is still and only the
 * thin bars breathe, which is perhaps a tenth of the pixels.
 */
export function Skeleton({
  className,
  tone = "bar",
  ...props
}: React.ComponentProps<"div"> & { readonly tone?: "bar" | "plate" }) {
  return (
    <Primitive
      data-tone={tone}
      /*
       * Hidden at the leaf, not at the region.
       *
       * `SkeletonPage` used to wrap its whole subtree in one `aria-hidden`, which was tidy
       * until the toolbar became real content living inside that subtree: `aria-hidden` on an
       * ancestor cannot be undone by a descendant, so the search box would have been hidden
       * from a screen reader and still focusable — the worst of both. Every grey block now
       * hides itself instead, and everything real around it stays reachable.
       */
      aria-hidden="true"
      className={cn(
        tone === "plate"
          ? "animate-none bg-skeleton-plate"
          : "animate-none bg-skeleton motion-safe:animate-skeleton",
        className,
      )}
      {...props}
    />
  );
}

/** The type scale a `SkeletonLine` can occupy one line of. */
const LINE_TEXT = {
  "3xs": "text-3xs",
  "2xs": "text-2xs",
  xs: "text-xs",
  sm: "text-sm",
  base: "text-base",
  lg: "text-lg",
  xl: "text-xl",
  "2xl": "text-2xl",
} as const;

/**
 * A bar that takes up **exactly one line of real text**, and no more.
 *
 * This is the fix for the jump the owner saw. A placeholder written as `h-3.5` for a line of
 * `text-xs` is 14 px standing in for 17.4 px (`0.75rem × 1.45`), and a card with three such
 * lines lands nine pixels taller than the grey one it replaced — every row of the grid moves.
 * So the height is never stated: the wrapper carries the *same* type class as the text it
 * replaces and holds a no-break space, so the browser computes the same line box it will
 * compute for the real thing. The visible bar is thinner than that box and centred in it,
 * which keeps the light look and costs nothing in geometry.
 */
export function SkeletonLine({
  text = "xs",
  width = "w-full",
  bar = "h-2.5",
  tone,
  className,
}: {
  readonly text?: keyof typeof LINE_TEXT;
  /** How wide the bar is — `w-1/3`, `w-24`. The line box is always full width. */
  readonly width?: string;
  /** How thick the bar is inside the line box. */
  readonly bar?: string;
  readonly tone?: "bar" | "plate";
  readonly className?: string;
}) {
  return (
    <span className={cn("flex items-center", LINE_TEXT[text], className)}>
      <Skeleton tone={tone} className={cn(bar, width)} />
      {/* Invisible, and the whole point: it is what gives the row a real line box. */}
      <span aria-hidden="true" className="w-0 overflow-hidden whitespace-pre">
        {" "}
      </span>
    </span>
  );
}

/**
 * `components/status-badge.tsx`'s `ToneBadge`: `h-5 rounded-sm`, never a pill.
 *
 * Written once here because four composites below used to draw it as `h-5 rounded-xl`, which
 * is a 14 px radius in front of a 4 px one — the same box, visibly the wrong shape.
 */
export function SkeletonBadge({ width = "w-12" }: { readonly width?: string }) {
  return <Skeleton className={cn("h-5 shrink-0 rounded-sm", width)} />;
}

export interface SkeletonPageProps {
  /**
   * Which page is being waited for, said once to a screen reader: "Loading the album grid…".
   * A sentence, not a word — it is the only thing read out of the whole region.
   */
  readonly label: string;
  /** Names this skeleton for the E2E suite; `data-testid="page-skeleton"` is always set too. */
  readonly name: string;
  readonly children: ReactNode;
  readonly className?: string;
}

/**
 * The region every `pendingComponent` returns.
 *
 * `aria-busy` on the wrapper, and one visually hidden sentence that *is* the live region:
 * `role="status"` sits on the `<span>` and not on the container. That looks like a detail and
 * is not. A pending page now holds real, interactive controls — the search box, the filter
 * builder, the preset links — and a live region announces its whole subtree every time
 * anything in it changes, so leaving `role="status"` on the container would have made a
 * screen reader recite the toolbar on every keystroke. The announcement is one sentence whose
 * text never changes; the placeholders hide themselves (see `Skeleton`); the controls are
 * ordinary content.
 *
 * Every page sets the same `data-testid="page-skeleton"` so a test can wait for "a skeleton"
 * without knowing which, and `data-skeleton` says which one it got.
 */
export function SkeletonPage({ label, name, children, className }: SkeletonPageProps) {
  return (
    <div aria-busy="true" data-testid="page-skeleton" data-skeleton={name} className={className}>
      <span role="status" className="sr-only">
        {label}
      </span>
      {/*
        Everything below is a second copy of controls the settled page also renders, and for
        the length of a re-suspend both copies are in the document. `PendingTree` is what tells
        them apart, and it is the only place that decides how.

        The region's own `page-skeleton` stays plain on purpose: it exists in this tree and in
        no other, so there is nothing for it to collide with, and every spec that waits for "a
        skeleton" spells it that way.
      */}
      <PendingTree>{children}</PendingTree>
    </div>
  );
}

/**
 * The router's `defaultPendingComponent`: a header, a band of tiles, a list.
 *
 * It is the net under the thirty bespoke ones, not a design. Every `_app` route declares its
 * own, so this is what a route added *tomorrow* gets for free — and, in principle, what the
 * `_app` layout itself would show if its own loader were ever the slow one.
 */
export function SkeletonFallback() {
  return (
    <SkeletonPage name="fallback" label="Loading the page…">
      <SkeletonPageHeader />
      <SkeletonTiles count={4} className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4" />
      <SkeletonTable columns={["w-9", "w-1/3", "w-1/4", "w-20"]} rows={6} />
    </SkeletonPage>
  );
}

/** A run of body-text lines, the last one short, as a paragraph resolves to. */
export function SkeletonText({
  lines = 2,
  className,
}: {
  readonly lines?: number;
  readonly className?: string;
}) {
  return (
    <div className={cn("flex flex-col", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <SkeletonLine
          key={index}
          text="sm"
          bar="h-3"
          width={index === lines - 1 ? "w-2/3" : "w-full"}
        />
      ))}
    </div>
  );
}

/**
 * `components/page-header.tsx`: title, one line of context, the action buttons.
 *
 * `text-lg` over `text-sm`, at zero gap and `mt-0.5`, because that is literally what
 * `PageHeader` renders — an `h1` and a `p`. The old version stacked an `h-5` and an `h-3.5`
 * bar with `gap-2` between them and came out six pixels short of the header it replaced.
 */
export function SkeletonPageHeader({
  actions = 1,
  className,
}: {
  readonly actions?: number;
  readonly className?: string;
}) {
  return (
    <div className={cn("mb-5 flex items-end justify-between gap-4", className)}>
      <div className="min-w-0">
        <SkeletonLine text="lg" bar="h-4" width="w-40" />
        <SkeletonLine text="sm" bar="h-3" width="w-80" className="mt-0.5 max-w-full" />
      </div>
      {actions === 0 ? null : (
        <div className="flex shrink-0 gap-2">
          {Array.from({ length: actions }, (_, index) => (
            <Skeleton key={index} tone="plate" className="h-8 w-24 rounded-lg" />
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * `components/stat-tile.tsx`: label, one big number, one line of detail.
 *
 * The number is `text-2xl` — a 32 px line, not the 28 px bar this used to draw — so a band of
 * tiles is the same height full as empty, and the toolbar under it does not step down when the
 * counts land.
 */
export function SkeletonTile() {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-1 px-3.5 py-3">
      <SkeletonLine text="2xs" bar="h-2.5" width="w-20" />
      <SkeletonLine text="2xl" bar="h-6" width="w-16" />
      <SkeletonLine text="2xs" bar="h-2.5" width="w-24" />
    </div>
  );
}

/**
 * A row of tiles at the caller's own breakpoints.
 *
 * `className` carries the grid, because the six-up dashboard, the four-up library and the
 * seven-up quality page are three different grids and the skeleton has to jump to none of them.
 */
export function SkeletonTiles({
  count,
  className,
}: {
  readonly count: number;
  readonly className?: string;
}) {
  return (
    <div className={className}>
      {Array.from({ length: count }, (_, index) => (
        <SkeletonTile key={index} />
      ))}
    </div>
  );
}

/**
 * One column of a `SkeletonTable`: either a width for a text cell, or the cover slot the
 * column really holds.
 *
 * The distinction matters because a cover is what sets the row's height. A track row is 37 px
 * tall because `Cover size="xs"` is 24 px inside `py-1.5`, not because its text is; a
 * skeleton that drew a text bar there was three pixels short a row on `/library/tracks` and
 * fourteen on `/library/artists`, which is half a screen of drift over ten rows.
 */
export type SkeletonColumn = string | { readonly cover: "xs" | "sm" | "md" };

const COVER_BOX = { xs: "size-6", sm: "size-9", md: "size-14" } as const;

/**
 * `components/data-table.tsx` inside the rounded card the pages wrap it in.
 *
 * Built from the *same* `Table` primitives and the same paddings `DataTable` uses — `h-8
 * px-2.5` on the head, `px-2.5 py-1.5` on the cell — rather than from a stack of flex rows
 * approximating them. Approximating them is how the old one ended up with 34 px rows under a
 * 26 px header in front of a table with 37 px rows under a 32 px header.
 */
export function SkeletonTable({
  columns,
  rows = 8,
  pager = false,
  className,
}: {
  readonly columns: readonly SkeletonColumn[];
  readonly rows?: number;
  readonly pager?: boolean;
  readonly className?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-line bg-surface-1", className)}>
      <Table className="text-xs">
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            {columns.map((column, index) => (
              <TableHead
                key={index}
                className={cn("h-8 px-2.5", typeof column === "string" ? column : "w-10")}
              >
                <SkeletonLine
                  text="2xs"
                  bar="h-2"
                  width={typeof column === "string" ? "w-full" : "w-4"}
                />
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {Array.from({ length: rows }, (_, row) => (
            <TableRow key={row} className="border-line hover:bg-transparent">
              {columns.map((column, index) => (
                <TableCell key={index} className="border-line px-2.5 py-1.5 align-middle">
                  {typeof column === "string" ? (
                    <SkeletonLine text="xs" bar="h-3" />
                  ) : (
                    <Skeleton tone="plate" className={cn(COVER_BOX[column.cover], "rounded-sm")} />
                  )}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
      {/* `components/pager.tsx`: `border-t px-3 py-1.5`, a sentence on the left, two icon
          buttons on the right. It is part of the card and would otherwise appear from
          nowhere under the last row. */}
      {pager ? (
        <div className="flex items-center justify-between gap-2 border-t border-line px-3 py-1.5">
          <SkeletonLine text="2xs" bar="h-2.5" width="w-40" />
          <span className="flex gap-1.5">
            <Skeleton tone="plate" className="size-6 rounded-md" />
            <Skeleton tone="plate" className="size-6 rounded-md" />
          </span>
        </div>
      ) : null}
    </div>
  );
}

/** A bordered section with a titled header — the Console's one card shape. */
export function SkeletonCard({
  children,
  action = false,
  className,
  bodyClassName,
}: {
  readonly children?: ReactNode;
  readonly action?: boolean;
  readonly className?: string;
  readonly bodyClassName?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-line bg-surface-1", className)}>
      <header className="flex items-center justify-between border-b border-line px-3.5 py-2.5">
        <Skeleton className="h-3.5 w-28" />
        {action ? <Skeleton className="h-5 w-16 rounded-md" /> : null}
      </header>
      <div className={cn("px-3.5 py-3", bodyClassName)}>{children}</div>
    </section>
  );
}

/** The dashboard's lists: cover, two lines, a badge, a timestamp — per row. */
export function SkeletonMediaRows({ rows = 3 }: { readonly rows?: number }) {
  return (
    <div className="flex flex-col">
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className="flex items-center gap-3 border-b border-line px-3.5 py-2.5 last:border-b-0"
        >
          <Skeleton tone="plate" className="size-9 shrink-0 rounded-sm" />
          <div className="flex min-w-0 flex-1 flex-col">
            <SkeletonLine text="xs" bar="h-3" width="w-1/2" />
            <SkeletonLine text="2xs" bar="h-2.5" width="w-1/3" />
          </div>
          <SkeletonBadge width="w-16" />
          <SkeletonLine text="2xs" bar="h-2.5" width="w-12" className="shrink-0" />
        </div>
      ))}
    </div>
  );
}

/** `components/key-value.tsx`: a label column sized to its content, values beside it. */
export function SkeletonKeyValues({ rows = 5 }: { readonly rows?: number }) {
  return (
    <div className="flex flex-col gap-2">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-3 w-24 shrink-0" />
          <Skeleton className="h-3 w-full" />
        </div>
      ))}
    </div>
  );
}

/**
 * `components/library/album-card.tsx`: a square cover, the title, the artist, the badge.
 *
 * Line for line, `AlbumCard`'s own box: `flex flex-col gap-1.5`, a `rounded-md` square, a
 * `text-xs` title, a `text-2xs` credit and an `h-5 rounded-sm` `ToneBadge`. It used to be
 * 8.8 px shorter than the card it stood in for — a whole grid's worth of that is the jump the
 * owner photographed.
 */
export function SkeletonAlbumCard() {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton tone="plate" className="aspect-square w-full rounded-md" />
      <SkeletonLine text="xs" bar="h-3" width="w-3/4" />
      <SkeletonLine text="2xs" bar="h-2.5" width="w-1/2" />
      <div className="flex items-center gap-1.5">
        <SkeletonBadge width="w-10" />
      </div>
    </div>
  );
}

/** The album grid, at `/library`'s own breakpoints so nothing reflows when the rows land. */
export function SkeletonAlbumGrid({ count = 12 }: { readonly count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6">
      {Array.from({ length: count }, (_, index) => (
        <SkeletonAlbumCard key={index} />
      ))}
    </div>
  );
}

/**
 * The header an album, an artist and a track detail page share: a large square on the left,
 * the eyebrow, the title, the credit and a row of badges on the right, the actions at the end.
 */
export function SkeletonDetailHeader({
  cover = "xl",
  actions = 3,
  badges = 5,
  className,
}: {
  readonly cover?: "none" | "lg" | "xl";
  readonly actions?: number;
  readonly badges?: number;
  readonly className?: string;
}) {
  return (
    <div className={cn("mb-4 flex flex-wrap items-start gap-5", className)}>
      {cover === "none" ? null : (
        <Skeleton
          tone="plate"
          className={cn("aspect-square shrink-0 rounded-sm", cover === "xl" ? "w-40" : "w-24")}
        />
      )}
      <div className="flex min-w-0 grow flex-col gap-1">
        <SkeletonLine text="2xs" bar="h-2.5" width="w-24" />
        <SkeletonLine text="xl" bar="h-5" width="w-72" className="max-w-full" />
        <SkeletonLine text="sm" bar="h-3" width="w-48" />
        <div className="mt-1 flex flex-wrap gap-1.5">
          {Array.from({ length: badges }, (_, index) => (
            <SkeletonBadge key={index} width="w-20" />
          ))}
        </div>
      </div>
      {actions === 0 ? null : (
        <div className="flex shrink-0 gap-2">
          {Array.from({ length: actions }, (_, index) => (
            <Skeleton key={index} tone="plate" className="h-8 w-24 rounded-lg" />
          ))}
        </div>
      )}
    </div>
  );
}

/** The tab strip a detail page carries under its header. */
export function SkeletonTabs({ count = 6 }: { readonly count?: number }) {
  return (
    <div className="mb-3 flex flex-wrap gap-1 border-b border-line">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="mb-1 h-5 w-20" />
      ))}
    </div>
  );
}

/**
 * One Settings `Section` with its `FormRow`s — the label column and the control beside it, at
 * the same `form-row-grid` split `components/settings/controls.tsx` uses.
 */
export function SkeletonFormSection({ rows = 3 }: { readonly rows?: number }) {
  return (
    <section className="rounded-xl border border-line bg-surface-1 px-3.5 py-1">
      <header className="flex flex-col gap-1.5 border-b border-line py-2.5">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-2.5 w-72 max-w-full" />
      </header>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="form-row-grid border-b border-line py-3 last:border-b-0">
          <div className="flex flex-col gap-1.5">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-2.5 w-44" />
          </div>
          <Skeleton className="h-7 w-64 max-w-full rounded-lg" />
        </div>
      ))}
    </section>
  );
}

/**
 * A whole Settings tab, announced as one.
 *
 * Every tab's `pendingComponent` is this with a different `rows` — the seven tabs are seven
 * stacks of the same `Section`/`FormRow` pair, and seven hand-written skeletons of one layout
 * would drift the first time `controls.tsx` changed a padding.
 */
export function SkeletonSettingsTab({
  name,
  label,
  rows,
  save = true,
  callout = false,
}: {
  readonly name: string;
  readonly label: string;
  readonly rows: readonly number[];
  readonly save?: boolean;
  readonly callout?: boolean;
}) {
  return (
    <SkeletonPage name={`settings-${name}`} label={label}>
      <SkeletonSettingsForm rows={rows} save={save} callout={callout} />
    </SkeletonPage>
  );
}

/**
 * A whole Settings tab: a stack of sections and the save bar.
 *
 * `rows` is per section, in order, so a tab that opens with a two-row block in front of a
 * six-row one says so and the page below does not slide when the real form arrives.
 */
export function SkeletonSettingsForm({
  rows,
  save = true,
  callout = false,
}: {
  readonly rows: readonly number[];
  readonly save?: boolean;
  readonly callout?: boolean;
}) {
  return (
    <div className="flex flex-col gap-3.5">
      {callout ? <Skeleton className="h-16 w-full rounded-lg" /> : null}
      {rows.map((count, index) => (
        <SkeletonFormSection key={index} rows={count} />
      ))}
      {save ? (
        <div className="flex items-center justify-end gap-2">
          <Skeleton className="h-8 w-28 rounded-lg" />
        </div>
      ) : null}
    </div>
  );
}
