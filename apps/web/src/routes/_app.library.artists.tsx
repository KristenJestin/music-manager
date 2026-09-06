/**
 * `/library/artists` — who is in the library, and how much of them.
 *
 * Grouped by `library_albums.album_artist` rather than by MBID, because that string is what
 * the folders are named after: an artist page that disagreed with the directory tree would be
 * describing a different library. The MBID, the country and the image come from
 * `artists_cache` when a document knew one, and are simply blank when it did not — the page
 * says what it knows and does not guess.
 */
import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { z } from "zod";
import { ExternalLink, Search } from "lucide-react";
import { Input } from "#/components/ui/input.tsx";
import { Cover } from "#/components/cover.tsx";
import { DataTable, type Column } from "#/components/data-table.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { short } from "#/lib/format.ts";
import type { ArtistRow } from "#/server/services/library.ts";
import { fetchArtists } from "#/server/functions/library.ts";

const search = z.object({ q: z.string().default("") });

export const Route = createFileRoute("/_app/library/artists")({
  validateSearch: search,
  loaderDeps: ({ search: params }) => params,
  loader: async ({ deps }) => await fetchArtists({ data: { search: deps.q } }),
  staticData: { crumbs: [{ label: "Library" }, { label: "Artists" }] },
  component: Artists,
});

function Artists() {
  const artists = Route.useLoaderData();
  const params = Route.useSearch();
  const navigate = useNavigate();
  const [query, setQuery] = useState(params.q);

  const columns: Column<ArtistRow>[] = [
    {
      key: "cover",
      header: "",
      className: "w-10",
      cell: (row) => <Cover size="sm" seed={row.mbid ?? row.name} label={row.name} />,
    },
    { key: "name", header: "Artist", cell: (row) => <span className="font-medium">{row.name}</span> },
    { key: "albums", header: "Albums", numeric: true, cell: (row) => row.albums },
    { key: "tracks", header: "Tracks", numeric: true, cell: (row) => row.tracks },
    {
      key: "country",
      header: "Country",
      cell: (row) => <span className="text-fg-2">{row.country ?? "—"}</span>,
    },
    {
      key: "sort",
      header: "Sort name",
      cell: (row) => <span className="text-fg-2">{row.sortName ?? "—"}</span>,
    },
    {
      key: "mbid",
      header: "MBID",
      cell: (row) =>
        row.mbid === null ? (
          <span className="font-mono text-2xs text-fg-3">—</span>
        ) : (
          <a
            href={`https://musicbrainz.org/artist/${row.mbid}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-2xs text-fg-3 hover:text-primary"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            {short(row.mbid)}
            <ExternalLink className="size-3" aria-hidden="true" />
          </a>
        ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Artists"
        description={`${artists.length} artist(s), as the library folders name them.`}
      />

      <div className="mb-3 flex items-center gap-2">
        <label className="flex h-7 min-w-64 items-center gap-1.5 rounded-lg border border-line bg-surface-1 px-2">
          <Search className="size-3.5 text-fg-3" aria-hidden="true" />
          <Input
            data-testid="artists-search"
            value={query}
            placeholder="Search artists…"
            onChange={(event) => {
              setQuery(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                void navigate({ to: "/library/artists", search: { q: query } });
              }
            }}
            className="h-6 border-0 bg-transparent px-0 text-xs shadow-none focus-visible:ring-0"
          />
        </label>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-surface-1">
        <DataTable
          data-testid="artists-table"
          columns={columns}
          rows={artists}
          rowKey={(row) => row.name}
          onRowClick={(row) => {
            void navigate({
              to: "/library",
              search: { q: row.name, filter: "all", sort: "artist", profile: "global" },
            });
          }}
          empty="No artist yet — the library is empty."
        />
      </div>
    </>
  );
}
