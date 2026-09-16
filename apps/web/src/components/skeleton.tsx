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
 * Three rules hold for everything here.
 *
 * **The shape must be the one that lands.** A skeleton whose grid has four columns in front of
 * a page that renders six is its own jank — the content arrives and the page jumps. Every
 * composite below mirrors a real component (`StatTile`, `DataTable`, `AlbumCard`, the Settings
 * `Section`/`FormRow` pair) at the same paddings and the same breakpoints, and the per-page
 * composites live beside the pages they mirror so the two are edited together.
 *
 * **No shimmer for `prefers-reduced-motion`.** The pulse is behind `motion-safe:`, so a reader
 * who asked for stillness gets the tint and nothing moving. That is a variant rather than a
 * media query in `styles.css` because `components/ui/skeleton.tsx` is shadcn's file and must
 * stay re-addable with the CLI.
 *
 * **One announcement, not fifty rows.** `SkeletonPage` is the `role="status"` region and holds
 * the single visually-hidden sentence; everything inside it is `aria-hidden`, so a screen
 * reader hears "Loading the album grid…" once instead of reciting forty placeholder cells.
 */
import type { ReactNode } from "react";
import { cn } from "cn";
import { Skeleton as Primitive } from "#/components/ui/skeleton.tsx";

/**
 * One grey block.
 *
 * `animate-none motion-safe:animate-pulse` rather than shadcn's bare `animate-pulse`: the
 * first token wins over the primitive's in `cn`'s merge, and the second puts the pulse back
 * only inside `@media (prefers-reduced-motion: no-preference)`.
 *
 * `bg-surface-3` rather than the primitive's `bg-muted`, which is `surface-2` and therefore
 * nearly invisible on the `bg-surface-1` cards most of these sit in.
 */
export function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <Primitive
      className={cn("animate-none bg-surface-3 motion-safe:animate-pulse", className)}
      {...props}
    />
  );
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
 * `role="status"` (an implicit polite live region) with `aria-busy`, one visually hidden
 * sentence, and the placeholder tree `aria-hidden` underneath it. Every page sets the same
 * `data-testid="page-skeleton"` so a test can wait for "a skeleton" without knowing which, and
 * `data-skeleton` says which one it got.
 */
export function SkeletonPage({ label, name, children, className }: SkeletonPageProps) {
  return (
    <div
      role="status"
      aria-busy="true"
      data-testid="page-skeleton"
      data-skeleton={name}
      className={className}
    >
      <span className="sr-only">{label}</span>
      <div aria-hidden="true">{children}</div>
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

/** A run of text lines, the last one short, as a paragraph resolves to. */
export function SkeletonText({
  lines = 2,
  className,
}: {
  readonly lines?: number;
  readonly className?: string;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {Array.from({ length: lines }, (_, index) => (
        <Skeleton key={index} className={cn("h-3", index === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

/** `components/page-header.tsx`: title, one line of context, the action buttons. */
export function SkeletonPageHeader({
  actions = 1,
  className,
}: {
  readonly actions?: number;
  readonly className?: string;
}) {
  return (
    <div className={cn("mb-5 flex items-end justify-between gap-4", className)}>
      <div className="min-w-0 flex flex-col gap-2">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-3.5 w-80 max-w-full" />
      </div>
      {actions === 0 ? null : (
        <div className="flex shrink-0 gap-2">
          {Array.from({ length: actions }, (_, index) => (
            <Skeleton key={index} className="h-8 w-24 rounded-lg" />
          ))}
        </div>
      )}
    </div>
  );
}

/** `components/stat-tile.tsx`: label, one big number, one line of detail. */
export function SkeletonTile() {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-line bg-surface-1 px-3.5 py-3">
      <Skeleton className="h-3 w-20" />
      <Skeleton className="h-7 w-16" />
      <Skeleton className="h-2.5 w-24" />
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

/** The search box and the controls beside it, as `SearchInput` plus `Select`s render. */
export function SkeletonToolbar({ selects = 0 }: { readonly selects?: number }) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <Skeleton className="h-8 min-w-56 flex-1 rounded-lg" />
      {Array.from({ length: selects }, (_, index) => (
        <Skeleton key={index} className="h-7 w-36 rounded-lg" />
      ))}
    </div>
  );
}

/** `components/library/filter-bar.tsx`: one rounded strip above the rows. */
export function SkeletonFilterBar() {
  return <Skeleton className="mb-3 h-8 w-full rounded-lg" />;
}

/** `components/library/filter-chips.tsx`: a row of pills carrying counts. */
export function SkeletonChips({ count = 5 }: { readonly count?: number }) {
  return (
    <div className="mb-3 flex flex-wrap gap-1.5">
      {Array.from({ length: count }, (_, index) => (
        <Skeleton key={index} className="h-6 w-24 rounded-xl" />
      ))}
    </div>
  );
}

/**
 * `components/data-table.tsx` inside the rounded card the pages wrap it in.
 *
 * `columns` is a list of widths rather than a count, so the skeleton's header sits where the
 * real one will: the first column of most Console tables is a 36 px cover, not a text cell.
 */
export function SkeletonTable({
  columns,
  rows = 8,
  pager = false,
  className,
}: {
  readonly columns: readonly string[];
  readonly rows?: number;
  readonly pager?: boolean;
  readonly className?: string;
}) {
  return (
    <div className={cn("overflow-hidden rounded-xl border border-line bg-surface-1", className)}>
      <div className="flex items-center gap-2.5 border-b border-line px-2.5 py-2">
        {columns.map((width, index) => (
          <Skeleton key={index} className={cn("h-2.5", width)} />
        ))}
      </div>
      {Array.from({ length: rows }, (_, row) => (
        <div key={row} className="flex items-center gap-2.5 border-b border-line px-2.5 py-2.5">
          {columns.map((width, index) => (
            <Skeleton key={index} className={cn("h-3.5", width)} />
          ))}
        </div>
      ))}
      {pager ? (
        <div className="flex items-center justify-between gap-2 px-2.5 py-2">
          <Skeleton className="h-3 w-40" />
          <Skeleton className="h-6 w-32 rounded-lg" />
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
          <Skeleton className="size-9 shrink-0 rounded-sm" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-1/2" />
            <Skeleton className="h-2.5 w-1/3" />
          </div>
          <Skeleton className="h-5 w-16 rounded-xl" />
          <Skeleton className="h-2.5 w-12" />
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

/** `components/library/album-card.tsx`: a square cover, the title, the artist, the badges. */
export function SkeletonAlbumCard() {
  return (
    <div className="flex flex-col gap-1.5">
      <Skeleton className="aspect-square w-full rounded-md" />
      <Skeleton className="h-3.5 w-3/4" />
      <Skeleton className="h-2.5 w-1/2" />
      <Skeleton className="h-5 w-12 rounded-xl" />
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
          className={cn("aspect-square shrink-0 rounded-sm", cover === "xl" ? "w-40" : "w-24")}
        />
      )}
      <div className="flex min-w-0 grow flex-col gap-2">
        <Skeleton className="h-2.5 w-24" />
        <Skeleton className="h-6 w-72 max-w-full" />
        <Skeleton className="h-3.5 w-48" />
        <div className="mt-1 flex flex-wrap gap-1.5">
          {Array.from({ length: badges }, (_, index) => (
            <Skeleton key={index} className="h-5 w-20 rounded-xl" />
          ))}
        </div>
      </div>
      {actions === 0 ? null : (
        <div className="flex shrink-0 gap-2">
          {Array.from({ length: actions }, (_, index) => (
            <Skeleton key={index} className="h-8 w-24 rounded-lg" />
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
