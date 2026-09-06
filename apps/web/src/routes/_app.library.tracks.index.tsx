/**
 * `/library/tracks` — every file, one row each.
 *
 * The album grid is for browsing; this is for *finding* — by title, by artist, by MBID, by
 * path — and for the questions that cut across albums: which tracks have no synchronised
 * lyrics, which have no ReplayGain, which are behind the tag schema.
 *
 * Paged at sixty rows. The filter and the page are in the URL like everywhere else.
 */
import { useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";

import { DataTable, type Column } from "#/components/data-table.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { SearchInput } from "#/components/search-input.tsx";
import { ToneBadge, scoreTone } from "#/components/status-badge.tsx";
import { FilterChips } from "#/components/library/filter-chips.tsx";
import { SchemaBadge } from "#/components/library/schema.tsx";
import { bytes, mmss, pct } from "#/lib/format.ts";
import { TimeAgo } from "#/components/time-ago.tsx";
import { TRACK_FILTERS } from "#/lib/library-filters.ts";
import type { TrackRow } from "#/server/services/library.ts";
import { fetchTracks } from "#/server/functions/library.ts";

const search = z.object({
  q: z.string().default(""),
  filter: z.enum(TRACK_FILTERS).default("all"),
  page: z.number().int().min(0).default(0),
});

export const Route = createFileRoute("/_app/library/tracks/")({
  validateSearch: search,
  loaderDeps: ({ search: params }) => params,
  loader: async ({ deps }) =>
    await fetchTracks({ data: { search: deps.q, filter: deps.filter, page: deps.page } }),
  staticData: { crumbs: [{ label: "Library" }, { label: "Tracks" }] },
  component: Tracks,
});

const LABELS: Record<(typeof TRACK_FILTERS)[number], string> = {
  all: "All",
  nolyrics: "No lyrics",
  noreplaygain: "No ReplayGain",
  schema: "Behind schema",
  untagged: "No recording MBID",
};

const PAGE_SIZE = 60;

function Tracks() {
  const { tracks, total, counts, currentSchema } = Route.useLoaderData();
  const params = Route.useSearch();
  const navigate = useNavigate();
  const [query, setQuery] = useState(params.q);
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

  const from = params.page * PAGE_SIZE;

  return (
    <>
      <PageHeader
        title="Tracks"
        description={`${counts.all} track(s) in the library · projection v${currentSchema}`}
      />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        <SearchInput
          data-testid="tracks-search"
          className="min-w-64 flex-1"
          label="Search tracks"
          placeholder="Title, artist, album, MBID, path…"
          value={query}
          onValueChange={setQuery}
          onSubmit={(q) => {
            void navigate({ to: "/library/tracks", search: { ...params, q, page: 0 } });
          }}
        />
      </div>

      <FilterChips
        testId="track-filters"
        chips={TRACK_FILTERS.map((filter) => ({
          value: filter,
          label: LABELS[filter],
          count: counts[filter],
        }))}
        active={params.filter}
        link={(filter) => ({ to: "/library/tracks", search: { ...params, filter, page: 0 } })}
      />

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
        <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-2xs text-fg-2">
          <span>
            {total === 0 ? 0 : from + 1}–{Math.min(total, from + tracks.length)} of {total}
          </span>
          <span className="flex gap-1.5">
            <Button
              size="xs"
              variant="outline"
              disabled={params.page === 0}
              onClick={() => {
                go(params.page - 1);
              }}
            >
              <ChevronLeft className="size-3" aria-hidden="true" />
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={from + tracks.length >= total}
              onClick={() => {
                go(params.page + 1);
              }}
            >
              <ChevronRight className="size-3" aria-hidden="true" />
            </Button>
          </span>
        </div>
      </div>
    </>
  );
}
