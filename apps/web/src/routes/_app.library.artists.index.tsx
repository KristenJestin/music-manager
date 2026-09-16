/**
 * `/library/artists` — who is in the library, and how much of them.
 *
 * Grouped by `library_albums.album_artist` rather than by MBID, because that string is what
 * the folders are named after: an artist page that disagreed with the directory tree would be
 * describing a different library. The MBID, the country and the image come from
 * `artists_cache` when a document knew one, and are simply blank when it did not — the page
 * says what it knows and does not guess.
 *
 * Every row leads to `/library/artists/$id`, addressed by `artistKey`: the MBID when the row
 * has one, the credited name when it does not. The rows are grouped by name and addressed by
 * id, and those are not in tension — see `artistDetail` (`server/services/library.ts`), which
 * resolves either and gathers the albums by name regardless.
 */
import { useState } from "react";
import { Link, createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";

import { artistImageSources, Cover } from "#/components/cover.tsx";
import { DataTable, type Column } from "#/components/data-table.tsx";
import { MbLink } from "#/components/mb-link.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { SearchInput } from "#/components/search-input.tsx";
import { artistKey } from "#/lib/artist-links.ts";
import { FilterBar } from "#/components/library/filter-bar.tsx";
import { ARTIST_FILTER_FIELDS } from "#/lib/filters/index.ts";
import type { ArtistRow } from "#/server/services/library.ts";
import { fetchArtists } from "#/server/functions/library.ts";

const search = z.object({
  q: z.string().default(""),
  /** The filter builder's tree, as the expression `lib/filters/schema.ts` reads. */
  f: z.string().max(2_000).default(""),
});

export const Route = createFileRoute("/_app/library/artists/")({
  validateSearch: search,
  loaderDeps: ({ search: params }) => params,
  loader: async ({ deps }) => await fetchArtists({ data: { search: deps.q, f: deps.f } }),
  staticData: { crumbs: [{ label: "Library" }, { label: "Artists" }] },
  component: Artists,
});

function Artists() {
  const { artists, filterError } = Route.useLoaderData();
  const params = Route.useSearch();
  const navigate = useNavigate();
  const [query, setQuery] = useState(params.q);

  const columns: Column<ArtistRow>[] = [
    {
      key: "cover",
      header: "",
      className: "w-10",
      cell: (row) => (
        <Cover
          size="sm"
          src={artistImageSources(row, "sm")}
          seed={row.mbid ?? row.name}
          label={row.name}
        />
      ),
    },
    {
      key: "name",
      header: "Artist",
      cell: (row) => (
        <Link
          to="/library/artists/$id"
          params={{ id: artistKey(row) }}
          data-testid="artist-link"
          className="font-medium hover:text-primary"
          onClick={(event) => {
            // The row navigates to the same place; letting both fire would push two entries.
            event.stopPropagation();
          }}
        >
          {row.name}
        </Link>
      ),
    },
    { key: "albums", header: "Albums", numeric: true, cell: (row) => row.albums },
    { key: "tracks", header: "Tracks", numeric: true, cell: (row) => row.tracks },
    {
      key: "country",
      header: "Country",
      cell: (row) => <span className="text-fg-2">{row.country ?? "not set"}</span>,
    },
    {
      key: "sort",
      header: "Sort name",
      cell: (row) => <span className="text-fg-2">{row.sortName ?? "not set"}</span>,
    },
    {
      key: "mbid",
      header: "MBID",
      cell: (row) => <MbLink kind="artist" mbid={row.mbid} truncate stopPropagation />,
    },
  ];

  return (
    <>
      <PageHeader
        title="Artists"
        description={`${artists.length} artist(s), as the library folders name them.`}
      />

      <div className="mb-3 flex items-center gap-2">
        <SearchInput
          data-testid="artists-search"
          className="min-w-64"
          label="Search artists"
          placeholder="Search artists…"
          value={query}
          onValueChange={setQuery}
          onSubmit={(q) => {
            void navigate({ to: "/library/artists", search: { ...params, q } });
          }}
        />
      </div>

      <FilterBar
        testId="artist-filter-bar"
        fields={ARTIST_FILTER_FIELDS}
        value={params.f}
        error={filterError}
        search={{
          value: params.q,
          label: "Search:",
          onClear: () => {
            setQuery("");
            void navigate({ to: "/library/artists", search: { ...params, q: "" } });
          },
        }}
        onChange={(f) => {
          void navigate({ to: "/library/artists", search: { ...params, f } });
        }}
      />

      <div className="overflow-hidden rounded-xl border border-line bg-surface-1">
        <DataTable
          data-testid="artists-table"
          columns={columns}
          rows={artists}
          rowKey={(row) => row.name}
          onRowClick={(row) => {
            void navigate({ to: "/library/artists/$id", params: { id: artistKey(row) } });
          }}
          empty="No artist yet: the library is empty."
        />
      </div>
    </>
  );
}
