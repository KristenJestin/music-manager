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
import { useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { PROFILE_IDS } from "@mm/domain";
import { LayoutGrid, Plus, ShieldCheck } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Select, SelectContent, SelectItem, SelectTrigger } from "#/components/ui/select.tsx";

import { Callout } from "#/components/callout.tsx";
import { albumCoverSources, Cover } from "#/components/cover.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { SearchInput } from "#/components/search-input.tsx";
import { StatTile } from "#/components/stat-tile.tsx";
import { ToneBadge, scoreTone } from "#/components/status-badge.tsx";
import { FilterChips } from "#/components/library/filter-chips.tsx";
import { SchemaBadge } from "#/components/library/schema.tsx";
import { pct } from "#/lib/format.ts";
import { ALBUM_FILTERS, ALBUM_SORTS } from "#/lib/library-filters.ts";
import { fetchAlbums } from "#/server/functions/library.ts";

const search = z.object({
  q: z.string().default(""),
  filter: z.enum(ALBUM_FILTERS).default("all"),
  sort: z.enum(ALBUM_SORTS).default("recent"),
  profile: z.enum(["global", ...PROFILE_IDS]).default("global"),
});

export const Route = createFileRoute("/_app/library/")({
  validateSearch: search,
  loaderDeps: ({ search: params }) => params,
  loader: async ({ deps }) =>
    await fetchAlbums({
      data: { search: deps.q, filter: deps.filter, sort: deps.sort, profile: deps.profile },
    }),
  staticData: { crumbs: [{ label: "Library" }, { label: "Albums" }] },
  component: Albums,
});

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

function Albums() {
  const { albums, counts, stats } = Route.useLoaderData();
  const params = Route.useSearch();
  const navigate = useNavigate();
  const [query, setQuery] = useState(params.q);

  const profiled = params.profile !== "global";
  const scoreOf = (quality: (typeof albums)[number]["quality"]): number | null =>
    profiled ? quality.byProfile[params.profile as never] : quality.score;

  // Takes the value rather than reading `query`: the clear button changes the state and
  // submits in the same tick, so the state it would read is still the old one.
  const submit = (q: string): void => {
    void navigate({ to: "/library", search: { ...params, q } });
  };

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

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput
          data-testid="library-search"
          className="min-w-56 flex-1"
          label="Search albums"
          placeholder="Search albums, artists, MBID…"
          value={query}
          onValueChange={setQuery}
          onSubmit={submit}
        />
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
            className="border-line bg-surface-1 text-xs"
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
            className="border-line bg-surface-1 text-xs"
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
      </div>

      <FilterChips
        testId="library-filters"
        chips={ALBUM_FILTERS.map((filter) => ({
          value: filter,
          label: FILTER_LABELS[filter],
          count: counts[filter],
        }))}
        active={params.filter}
        link={(filter) => ({ to: "/library", search: { ...params, filter } })}
      />

      {albums.length === 0 ? (
        <Callout tone="info" data-testid="library-empty">
          Nothing here yet. An album appears once its files have been placed.{" "}
          <Link to="/import/new" className="text-primary">
            start an import
          </Link>
          .
        </Callout>
      ) : (
        <div
          data-testid="album-grid"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6"
        >
          {albums.map((album) => {
            const score = scoreOf(album.quality);
            const incomplete = album.presentCount < album.trackCount;
            return (
              <Link
                key={album.id}
                to="/library/albums/$id"
                params={{ id: album.id }}
                data-testid="album-card"
                data-album-title={album.title}
                className="group/album flex flex-col gap-1.5"
              >
                <div className="relative">
                  {/* The `cover.jpg` this library actually holds, then the Cover Art Archive,
                      then the gradient — the same order everywhere an album is drawn
                      (owner review C10). */}
                  <Cover
                    size="full"
                    seed={album.id}
                    label={album.title}
                    src={albumCoverSources(album)}
                  />
                  {incomplete ? (
                    <ToneBadge tone="warn" className="absolute top-1.5 left-1.5">
                      {album.presentCount}/{album.trackCount}
                    </ToneBadge>
                  ) : null}
                  {/*
                    A file that has gone, which is not the same as a track never imported
                    (DRIVE-1 §B5): the scan writes `missing_at`, so the grid can say it
                    without stat-ing hundreds of albums.
                  */}
                  {album.quality.missingCount > 0 ? (
                    <ToneBadge
                      tone="danger"
                      data-testid="album-missing"
                      className="absolute top-1.5 right-1.5"
                      title="The last library scan could not find these files on disk."
                    >
                      {album.quality.missingCount} missing
                    </ToneBadge>
                  ) : null}
                  {album.quality.untagged ? (
                    <ToneBadge
                      tone="info"
                      className="absolute right-1.5 bottom-1.5"
                      title="Imported from the YouTube tags alone, with no MusicBrainz release."
                    >
                      untagged
                    </ToneBadge>
                  ) : null}
                </div>
                <div className="truncate text-xs font-medium group-hover/album:text-primary">
                  {album.title}
                </div>
                <div className="truncate text-2xs text-fg-2">
                  {album.albumArtist}
                  {album.year === null ? "" : ` · ${String(album.year)}`}
                </div>
                <div className="flex items-center gap-1.5">
                  <ToneBadge tone={scoreTone(score)} title="Metadata completeness">
                    {pct(score)}
                  </ToneBadge>
                  {album.quality.filesBehind > 0 ? (
                    <SchemaBadge
                      version={album.quality.schemaVersion}
                      current={stats.currentSchema}
                    />
                  ) : null}
                </div>
              </Link>
            );
          })}
        </div>
      )}

      <p className="mt-4 flex items-center gap-1.5 text-2xs text-fg-3">
        <LayoutGrid className="size-3" aria-hidden="true" />
        {albums.length} of {counts.all} albums shown
        {profiled ? ` · scored as ${params.profile} reads them` : ""}. A profile changes the view,
        never the files: the superset is written whatever is selected here.
      </p>
    </>
  );
}
