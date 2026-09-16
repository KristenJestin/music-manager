/**
 * `/library/tracks` — every file, one row each.
 *
 * The album grid is for browsing; this is for *finding* — by title, by artist, by MBID, by
 * path — and for the questions that cut across albums: which tracks have no synchronised
 * lyrics, which have no ReplayGain, which are behind the tag schema.
 *
 * Paged at sixty rows. The filter and the page are in the URL like everywhere else.
 */
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { Cover, albumCoverSources } from "#/components/cover.tsx";
import { Pager } from "#/components/pager.tsx";
import { DataTable, type Column } from "#/components/data-table.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { ToneBadge, scoreTone } from "#/components/status-badge.tsx";
import { FilterNotice } from "#/components/library/filter-bar.tsx";
import { FilterToolbar } from "#/components/library/filter-toolbar.tsx";
import { SchemaBadge } from "#/components/library/schema.tsx";
import { SkeletonPage, SkeletonPageHeader, SkeletonTable } from "#/components/skeleton.tsx";
import { bytes, mmss, pct } from "#/lib/format.ts";
import { TimeAgo } from "#/components/time-ago.tsx";
import { TRACK_FILTER_FIELDS } from "#/lib/filters/index.ts";
import { TRACK_FILTERS } from "#/lib/library-filters.ts";
import type { TrackRow } from "#/server/services/library.ts";
import { fetchTracks } from "#/server/functions/library.ts";

const search = z.object({
  q: z.string().default(""),
  filter: z.enum(TRACK_FILTERS).default("all"),
  page: z.number().int().min(0).default(0),
  /** The filter builder's tree, as the expression `lib/filters/schema.ts` reads. */
  f: z.string().max(2_000).default(""),
});

export const Route = createFileRoute("/_app/library/tracks/")({
  validateSearch: search,
  loaderDeps: ({ search: params }) => params,
  loader: async ({ deps }) =>
    await fetchTracks({
      data: { search: deps.q, filter: deps.filter, page: deps.page, f: deps.f },
    }),
  staticData: { crumbs: [{ label: "Library" }, { label: "Tracks" }] },
  component: Tracks,
  pendingComponent: TracksPending,
});

/**
 * The real toolbar, then eleven columns and the pager as `Tracks` draws them.
 *
 * The widths below are the column list of the table under it, in order — number, cover, title,
 * artist, album, length, size, extras, metadata, schema, added — because a skeleton table with
 * evenly spaced columns is a page that visibly re-flows the moment the rows land. The second
 * entry says `{ cover: "xs" }` rather than a width, because that 24 px square is what makes a
 * track row 37 px tall and not 30.
 */
function TracksPending() {
  return (
    <SkeletonPage name="library-tracks" label="Loading the tracks table…">
      <SkeletonPageHeader actions={0} />
      <TracksToolbar counts={null} />
      <SkeletonTable
        pager
        rows={12}
        columns={[
          "w-6",
          { cover: "xs" },
          "w-1/5",
          "w-1/6",
          "w-1/6",
          "w-10",
          "w-12",
          "w-12",
          "w-12",
          "w-12",
          "w-14",
        ]}
      />
    </SkeletonPage>
  );
}

const LABELS: Record<(typeof TRACK_FILTERS)[number], string> = {
  all: "All",
  nolyrics: "No lyrics",
  noreplaygain: "No ReplayGain",
  schema: "Behind schema",
  untagged: "No recording MBID",
};

const PAGE_SIZE = 60;

/** The search box, the conditions and the presets of `/library/tracks`, from the URL alone. */
function TracksToolbar({
  counts,
}: {
  readonly counts: Record<(typeof TRACK_FILTERS)[number], number> | null;
}) {
  const params = Route.useSearch();
  const navigate = useNavigate();

  return (
    <FilterToolbar
      search={{
        value: params.q,
        label: "Search tracks",
        placeholder: "Title, artist, album, MBID, path…",
        testId: "tracks-search",
        onSubmit: (q) => {
          void navigate({ to: "/library/tracks", search: { ...params, q, page: 0 } });
        },
      }}
      conditions={{
        fields: TRACK_FILTER_FIELDS,
        value: params.f,
        testId: "track-filter-bar",
        onChange: (f) => {
          void navigate({ to: "/library/tracks", search: { ...params, f, page: 0 } });
        },
      }}
      presets={{
        chips: TRACK_FILTERS.map((filter) => ({
          value: filter,
          label: LABELS[filter],
          count: counts?.[filter] ?? null,
        })),
        active: params.filter,
        testId: "track-filters",
        // Every preset resets the page: "Behind schema, page 6" of a two-page set is an
        // empty table and a puzzled owner.
        link: (filter) => ({ to: "/library/tracks", search: { ...params, filter, page: 0 } }),
      }}
    />
  );
}

function Tracks() {
  const { tracks, total, counts, currentSchema, filterError } = Route.useLoaderData();
  const params = Route.useSearch();
  const navigate = useNavigate();

  const now = new Date();

  const go = (page: number): void => {
    void navigate({ to: "/library/tracks", search: { ...params, page } });
  };

  const columns: Column<TrackRow>[] = [
    {
      key: "n",
      header: "#",
      numeric: true,
      className: "w-10",
      cell: (row) => (
        <span className="text-fg-3">{String(row.trackNumber ?? 0).padStart(2, "0")}</span>
      ),
    },
    {
      key: "cover",
      header: "",
      className: "w-8",
      headClassName: "w-8",
      /*
       * The album's cover, not the track's: a file has no picture of its own. The gradient
       * with the initial is what a row falls back to, as everywhere else.
       */
      cell: (row) => (
        <Cover
          size="xs"
          seed={row.albumId ?? row.id}
          label={row.albumTitle ?? row.title}
          src={albumCoverSources(
            {
              id: row.albumId,
              releaseMbid: row.albumReleaseMbid,
              coverPath: row.albumCoverPath,
            },
            "xs",
          )}
        />
      ),
    },
    {
      key: "title",
      header: "Title",
      cell: (row) => <span className="font-medium">{row.title}</span>,
    },
    {
      key: "artist",
      header: "Artist",
      cell: (row) => <span className="text-fg-2">{row.artist ?? "unknown"}</span>,
    },
    {
      key: "album",
      header: "Album",
      cell: (row) =>
        row.albumId === null ? (
          <span className="text-fg-3">no album</span>
        ) : (
          <Link
            to="/library/albums/$id"
            params={{ id: row.albumId }}
            className="text-fg-2 hover:text-primary"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            {row.albumTitle}
          </Link>
        ),
    },
    { key: "length", header: "Length", numeric: true, cell: (row) => mmss(row.duration) },
    { key: "size", header: "Size", numeric: true, cell: (row) => bytes(row.size) },
    {
      key: "extras",
      header: "Extras",
      cell: (row) => (
        <span className="flex gap-1">
          {row.hasLyrics ? <ToneBadge tone="ok">lrc</ToneBadge> : null}
          {row.hasReplayGain ? <ToneBadge tone="ok">rg</ToneBadge> : null}
        </span>
      ),
    },
    {
      key: "score",
      header: "Metadata",
      cell: (row) => <ToneBadge tone={scoreTone(row.score)}>{pct(row.score)}</ToneBadge>,
    },
    {
      key: "schema",
      header: "Schema",
      cell: (row) => <SchemaBadge version={row.tagSchemaVersion} current={currentSchema} />,
    },
    {
      key: "added",
      header: "Added",
      cell: (row) => <TimeAgo at={row.addedAt} now={now} className="text-fg-3" />,
    },
  ];

  return (
    <>
      <PageHeader
        title="Tracks"
        description={`${counts.all} track(s) in the library · projection v${currentSchema}`}
      />

      <TracksToolbar counts={counts} />
      <FilterNotice fields={TRACK_FILTER_FIELDS} value={params.f} error={filterError} />

      <div className="overflow-hidden rounded-xl border border-line bg-surface-1">
        <DataTable
          data-testid="tracks-table"
          columns={columns}
          rows={tracks}
          rowKey={(row) => row.id}
          onRowClick={(row) => {
            void navigate({ to: "/library/tracks/$id", params: { id: row.id } });
          }}
          empty="No track matches."
        />
        <Pager
          page={params.page}
          pageSize={PAGE_SIZE}
          total={total}
          shown={tracks.length}
          onPage={go}
          noun="tracks"
        />
      </div>
    </>
  );
}
