/**
 * `/library` — the album grid.
 *
 * The one screen that answers "what do I actually have?", so it is a grid of covers with the
 * two facts that matter written on them: how many tracks are present, and how complete the
 * metadata is. Everything else — the filters, the sort, the profile — is in the URL, so a
 * filtered view is a link and the dashboard's tiles can point straight at one.
 *
 * The completeness badge is the *global* score by default. Switching the profile re-labels
 * every badge with "as Navidrome reads it" and changes nothing about the files, which is said
 * in the toolbar rather than left to be inferred.
 */
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { PROFILE_IDS } from "@mm/domain";
import { LayoutGrid, Plus, ShieldCheck } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger } from "#/components/ui/select.tsx";

import { Callout } from "#/components/callout.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { StatTile } from "#/components/stat-tile.tsx";
import { scoreTone } from "#/components/status-badge.tsx";
import { AlbumCard } from "#/components/library/album-card.tsx";
import { FilterNotice } from "#/components/library/filter-bar.tsx";
import { FilterToolbar } from "#/components/library/filter-toolbar.tsx";
import {
  SkeletonAlbumGrid,
  SkeletonPage,
  SkeletonPageHeader,
  SkeletonTiles,
} from "#/components/skeleton.tsx";
import { pct } from "#/lib/format.ts";
import { ALBUM_FILTER_FIELDS } from "#/lib/filters/index.ts";
import { ALBUM_FILTERS, ALBUM_SORTS } from "#/lib/library-filters.ts";
import { fetchAlbums } from "#/server/functions/library.ts";

const search = z.object({
  q: z.string().default(""),
  filter: z.enum(ALBUM_FILTERS).default("all"),
  sort: z.enum(ALBUM_SORTS).default("recent"),
  profile: z.enum(["global", ...PROFILE_IDS]).default("global"),
  /*
   * The filter builder's tree, as the expression `lib/filters/schema.ts` reads. A string
   * here rather than a parsed object: `validateSearch` runs in the browser on every
   * navigation, and what has to survive is the *link* — the tree is validated against this
   * page's whitelist on the server, which is the only side that can refuse it usefully.
   */
  f: z.string().max(2_000).default(""),
});

export const Route = createFileRoute("/_app/library/")({
  validateSearch: search,
  loaderDeps: ({ search: params }) => params,
  loader: async ({ deps }) =>
    await fetchAlbums({
      data: {
        search: deps.q,
        filter: deps.filter,
        sort: deps.sort,
        profile: deps.profile,
        f: deps.f,
      },
    }),
  staticData: { crumbs: [{ label: "Library" }, { label: "Albums" }] },
  component: Albums,
  pendingComponent: AlbumsPending,
});

/**
 * The grid, as covers that are not there yet — and the toolbar, for real.
 *
 * The toolbar is the point. Everything in it comes out of `Route.useSearch()`, so there is no
 * reason for a navigation to take the search box, the filter builder, the presets and the two
 * selects away and give them back a moment later; doing that was what made every click feel
 * like the page had been thrown out and rebuilt. The one thing this cannot know is the
 * per-preset counts, which is why they go in as `null` and draw a dash in a slot the right
 * width. Only the header, the tiles and the grid are still grey.
 *
 * Twelve cards rather than the six hundred that will land: the skeleton's job is to fill the
 * first screen, and a placeholder below the fold costs layout work nobody sees. The grid
 * itself is the page's own `grid-cols-2 … xl:grid-cols-6`, so the columns do not change count
 * when the real covers arrive — which is the one way an album grid can still jump.
 */
function AlbumsPending() {
  return (
    <SkeletonPage name="library-albums" label="Loading the album grid…">
      <SkeletonPageHeader actions={2} />
      <SkeletonTiles count={4} className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4" />
      <AlbumsToolbar counts={null} />
      <SkeletonAlbumGrid count={12} />
    </SkeletonPage>
  );
}

const FILTER_LABELS: Record<(typeof ALBUM_FILTERS)[number], string> = {
  all: "All",
  incomplete: "Incomplete",
  untagged: "Untagged",
  nocover: "No cover",
  ytcover: "YouTube cover",
  schema: "Behind schema",
};

const SORT_LABELS: Record<(typeof ALBUM_SORTS)[number], string> = {
  recent: "Recently added",
  artist: "Artist A–Z",
  year: "Year",
  score: "Worst metadata first",
};

/**
 * Everything on this page that filters, sorts or re-scores — in one row, from the URL alone.
 *
 * Rendered by `Albums` and by `AlbumsPending` alike, which is the whole trick: the two differ
 * only in whether `counts` is a number per preset or `null`.
 */
function AlbumsToolbar({
  counts,
}: {
  readonly counts: Record<(typeof ALBUM_FILTERS)[number], number> | null;
}) {
  const params = Route.useSearch();
  const navigate = useNavigate();

  return (
    <FilterToolbar
      search={{
        value: params.q,
        label: "Search albums",
        placeholder: "Search albums, artists, MBID…",
        testId: "library-search",
        onSubmit: (q) => {
          void navigate({ to: "/library", search: { ...params, q } });
        },
      }}
      conditions={{
        fields: ALBUM_FILTER_FIELDS,
        value: params.f,
        testId: "album-filter-bar",
        onChange: (f) => {
          void navigate({ to: "/library", search: { ...params, f } });
        },
      }}
      presets={{
        chips: ALBUM_FILTERS.map((filter) => ({
          value: filter,
          label: FILTER_LABELS[filter],
          count: counts?.[filter] ?? null,
        })),
        active: params.filter,
        testId: "library-filters",
        link: (filter) => ({ to: "/library", search: { ...params, filter } }),
      }}
    >
      <Select
        value={params.sort}
        onValueChange={(next: string | null) => {
          if (next === null) return;
          void navigate({
            to: "/library",
            search: { ...params, sort: next as typeof params.sort },
          });
        }}
      >
        <SelectTrigger
          size="sm"
          data-testid="library-sort"
          aria-label="Sort albums"
          className="max-w-36 border-line bg-surface-1 text-xs"
        >
          <span data-slot="select-value" className="truncate">
            {SORT_LABELS[params.sort]}
          </span>
        </SelectTrigger>
        <SelectContent className="text-xs">
          {ALBUM_SORTS.map((sort) => (
            <SelectItem key={sort} value={sort} className="text-xs">
              {SORT_LABELS[sort]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={params.profile}
        onValueChange={(next: string | null) => {
          if (next === null) return;
          void navigate({
            to: "/library",
            search: { ...params, profile: next as typeof params.profile },
          });
        }}
      >
        <SelectTrigger
          size="sm"
          data-testid="library-profile"
          aria-label="Scoring profile"
          className="max-w-36 border-line bg-surface-1 text-xs"
        >
          <span data-slot="select-value" className="truncate">
            {params.profile === "global" ? "Global (superset)" : params.profile}
          </span>
        </SelectTrigger>
        <SelectContent className="text-xs">
          <SelectItem value="global" className="text-xs">
            Global (superset)
          </SelectItem>
          {PROFILE_IDS.map((id) => (
            <SelectItem key={id} value={id} className="text-xs">
              {id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </FilterToolbar>
  );
}

function Albums() {
  const { albums, counts, stats, total, filterError } = Route.useLoaderData();
  const params = Route.useSearch();

  const profiled = params.profile !== "global";
  const scoreOf = (quality: (typeof albums)[number]["quality"]): number | null =>
    profiled ? quality.byProfile[params.profile as never] : quality.score;

  return (
    <>
      <PageHeader
        title="Albums"
        description={
          <>
            {stats.albums} albums · {stats.tracks} tracks · metadata{" "}
            <span className="font-mono">{pct(stats.averageScore)}</span> on average
            {stats.filesBehind > 0 ? (
              <>
                {" "}
                ·{" "}
                <Link
                  to="/library/quality"
                  search={{ filter: "schema", profile: "global" }}
                  className="text-warn"
                >
                  {stats.filesBehind} file(s) behind the tag schema
                </Link>
              </>
            ) : null}
          </>
        }
        actions={
          <>
            <Button variant="outline" nativeButton={false} render={<Link to="/library/quality" />}>
              <ShieldCheck className="size-4" aria-hidden="true" /> Quality
            </Button>
            <Button nativeButton={false} render={<Link to="/import/new" />}>
              <Plus className="size-4" aria-hidden="true" /> Import
            </Button>
          </>
        }
      />

      <div className="mb-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile label="Albums" value={stats.albums} sub={`${stats.artists} artists`} />
        <StatTile
          label="Metadata"
          value={pct(
            profiled ? stats.averageByProfile[params.profile as never] : stats.averageScore,
          )}
          tone={scoreTone(
            profiled ? stats.averageByProfile[params.profile as never] : stats.averageScore,
          )}
          sub={profiled ? `as ${params.profile} reads it` : "against the superset"}
          icon={<ShieldCheck className="size-3.5" aria-hidden="true" />}
        />
        <StatTile
          label="Below 80%"
          value={stats.below80}
          tone={stats.below80 === 0 ? "ok" : "warn"}
          sub="needs attention first"
          to="/library/quality"
          search={{ filter: "below80", profile: params.profile }}
        />
        <StatTile
          label="Behind schema"
          value={stats.filesBehind}
          tone={stats.filesBehind === 0 ? "ok" : "warn"}
          sub={`files · projection v${stats.currentSchema}`}
          to="/library/quality"
          search={{ filter: "schema", profile: params.profile }}
        />
      </div>

      <AlbumsToolbar counts={counts} />
      <FilterNotice fields={ALBUM_FILTER_FIELDS} value={params.f} error={filterError} />

      {albums.length === 0 ? (
        <Callout tone="info" data-testid="library-empty">
          {/*
            "Nothing matches" and "nothing is here" are different facts and used to share one
            sentence, so a filter that excluded everything read as an empty library. `counts.all`
            is the library; `total` is what the filter left of it.
          */}
          {counts.all === 0 ? (
            <>
              Nothing here yet. An album appears once its files have been placed.{" "}
              <Link to="/import/new" className="text-primary">
                start an import
              </Link>
              .
            </>
          ) : (
            <>
              No album matches. {counts.all} album(s) are in the library — take a condition off the
              bar above to see them.
            </>
          )}
        </Callout>
      ) : (
        <div
          data-testid="album-grid"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6"
        >
          {albums.map((album) => (
            <AlbumCard
              key={album.id}
              album={album}
              score={scoreOf(album.quality)}
              currentSchema={stats.currentSchema}
            />
          ))}
        </div>
      )}

      <p className="mt-4 flex items-center gap-1.5 text-2xs text-fg-3">
        <LayoutGrid className="size-3" aria-hidden="true" />
        {albums.length} of {total} matching, {counts.all} in the library
        {profiled ? ` · scored as ${params.profile} reads them` : ""}. A profile changes the view,
        never the files: the superset is written whatever is selected here.
      </p>
    </>
  );
}
