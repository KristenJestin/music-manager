/**
 * `/library/artists/:id` — one artist: their picture, their shelf, and the way out to
 * MusicBrainz.
 *
 * `:id` is the MusicBrainz artist id when the library knows one and the credited name when it
 * does not; `artistDetail` (`server/services/library.ts`) resolves either and explains why it
 * is a pair rather than a single key.
 *
 * Three things are shown and the third is the one with a cost. The picture and the albums are
 * rows we already hold. The quick links are the `url-rels` MusicBrainz gave us when the
 * documents were built — already in `artists_cache.payload`, never read until now. The
 * comparison with MusicBrainz's discography is a *browse* request, so it renders straight away
 * when the raw cache already has the answer (an artist Discover has synced, or one somebody
 * pressed the button for) and is a button otherwise. No page view of this route ever spends a
 * request on its own.
 */
import { useState } from "react";
import { Link, createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { Disc3, ExternalLink, RefreshCw } from "lucide-react";
import { Button } from "#/components/ui/button.tsx";
import { Callout } from "#/components/callout.tsx";
import { artistImageSources, Cover } from "#/components/cover.tsx";
import { MbLink } from "#/components/mb-link.tsx";
import { PageHeader } from "#/components/page-header.tsx";
import { ToneBadge } from "#/components/status-badge.tsx";
import { AlbumCard } from "#/components/library/album-card.tsx";
import { useToast } from "#/components/shell/shell-context.tsx";
import {
  SkeletonAlbumGrid,
  SkeletonCard,
  SkeletonDetailHeader,
  SkeletonPage,
  Skeleton,
} from "#/components/skeleton.tsx";
import { dateTime } from "#/lib/format.ts";
import { readFailure } from "#/lib/errors.ts";
import type { ArtistShelf } from "#/server/services/discography.ts";
import { compareArtistDiscography, fetchArtist } from "#/server/functions/library.ts";
import { importReleaseGroup } from "#/server/functions/discover.ts";

export const Route = createFileRoute("/_app/library/artists/$id")({
  loader: async ({ params }) => await fetchArtist({ data: { id: params.id } }),
  staticData: {
    crumbs: [
      { label: "Library", to: "/library" },
      { label: "Artists", to: "/library/artists" },
      { label: "Artist" },
    ],
  },
  component: ArtistPage,
  pendingComponent: ArtistPending,
});

/**
 * The artist page's two halves: the portrait header, then the album grid, then the
 * MusicBrainz discography card. The grid uses the same six-column track as `/library`, because
 * it renders the very same `AlbumCard`.
 */
function ArtistPending() {
  return (
    <SkeletonPage name="library-artist" label="Loading the artist…">
      <SkeletonDetailHeader actions={0} badges={3} className="mb-5" />
      <Skeleton className="mb-2 h-3 w-24" />
      <SkeletonAlbumGrid count={6} />
      <div className="mt-6 mb-2 flex items-center justify-between gap-2">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-7 w-48 rounded-lg" />
      </div>
      <SkeletonCard bodyClassName="flex flex-col gap-2">
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-full" />
        <Skeleton className="h-3.5 w-2/3" />
      </SkeletonCard>
    </SkeletonPage>
  );
}

function ArtistPage() {
  const artist = Route.useLoaderData();
  const { id } = Route.useParams();
  const router = useRouter();
  const navigate = useNavigate();
  const toast = useToast();
  const [shelf, setShelf] = useState<ArtistShelf | null>(null);
  const [comparing, setComparing] = useState(false);
  const [importing, setImporting] = useState<string | null>(null);

  if (artist === null) {
    return (
      <>
        <PageHeader title="Unknown artist" description="Nothing in the library is credited here." />
        <Callout tone="warn" data-testid="artist-unknown">
          No artist matches <span className="font-mono">{id}</span>. They may have been renamed by a
          re-tag, or their last album deleted.{" "}
          <Link to="/library/artists" search={{ q: "" }} className="text-primary">
            Back to the artists
          </Link>
          .
        </Callout>
      </>
    );
  }

  const { name } = artist;
  const known = shelf ?? artist.shelf;

  const compare = (): void => {
    setComparing(true);
    void compareArtistDiscography({ data: { id } }).then(
      (answer) => {
        setComparing(false);
        if (answer === null) {
          toast("MusicBrainz has no release groups for this artist.", "warn");
          return;
        }
        setShelf(answer);
        toast(
          `${String(answer.have)} of ${String(answer.total)} release group(s) in the library.`,
          "ok",
        );
        // The answer is in the raw cache now, so the loader will find it for free from here on.
        void router.invalidate();
      },
      (error: unknown) => {
        setComparing(false);
        toast(readFailure(error).message, "danger");
      },
    );
  };

  /* A hole in the shelf becomes an open wizard: YouTube source, import, step 2, release. */
  const startImport = (releaseGroupMbid: string, title: string): void => {
    setImporting(releaseGroupMbid);
    void importReleaseGroup({
      data: { artist: name, title, releaseGroupMbid },
    }).then(
      (target) => {
        setImporting(null);
        toast(target.label, target.found ? "ok" : "warn");
        void navigate({
          to: "/import/new",
          search: {
            importId: target.importId,
            step: target.step,
            ...(target.release === null ? {} : { release: target.release }),
          },
        });
      },
      (error: unknown) => {
        setImporting(null);
        toast(readFailure(error).message, "danger");
      },
    );
  };

  return (
    <>
      {/* ---- header ---- */}
      <div className="mb-5 flex flex-wrap items-start gap-5">
        {/* The `artist.jpg` placed beside their folder, then the URL `artists_cache` holds. */}
        <div className="shrink-0" data-testid="artist-image">
          <Cover
            size="xl"
            seed={artist.mbid ?? artist.name}
            label={artist.name}
            src={artistImageSources(artist)}
          />
        </div>
        <div className="min-w-0 grow">
          <div className="text-2xs tracking-wider text-fg-2 uppercase">
            {artist.profile.kind ?? "artist"}
            {artist.country === null ? "" : ` · ${artist.country}`}
            {artist.profile.began === null ? "" : ` · ${artist.profile.began}`}
            {artist.profile.ended === null ? "" : `–${artist.profile.ended}`}
          </div>
          <h1 className="text-xl font-semibold" data-testid="artist-name">
            {artist.name}
          </h1>
          {artist.profile.disambiguation === null ? null : (
            <p className="text-xs text-fg-2">{artist.profile.disambiguation}</p>
          )}
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            <ToneBadge outline data-testid="artist-albums-count">
              {artist.albums.length} album(s)
            </ToneBadge>
            <ToneBadge outline>{artist.trackCount} track(s)</ToneBadge>
            {artist.sortName === null ? null : (
              <span className="text-2xs text-fg-3">sorts as {artist.sortName}</span>
            )}
          </div>

          {/* ---- quick links ---- */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5" data-testid="artist-links">
            <MbLink
              kind="artist"
              mbid={artist.mbid}
              label="MusicBrainz"
              missing="no MusicBrainz id yet"
              data-testid="artist-mb-link"
              className="rounded-md border border-line bg-surface-1 px-2 py-1 text-2xs"
            />
            {artist.links.map((link) => (
              <a
                key={link.url}
                href={link.url}
                target="_blank"
                rel="noreferrer"
                title={`${link.relation} — ${link.url}`}
                data-testid="artist-external-link"
                className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-1 px-2 py-1 text-2xs text-fg-2 hover:border-primary-edge hover:text-primary"
              >
                {link.label}
                <ExternalLink className="size-3" aria-hidden="true" />
                <span className="sr-only">(opens in a new tab)</span>
              </a>
            ))}
          </div>
          {artist.mbid !== null && artist.links.length === 0 ? (
            <p className="mt-1.5 text-2xs text-fg-3">
              MusicBrainz listed no external addresses for this artist, or this row predates the
              lookup that stores them.
            </p>
          ) : null}
        </div>
      </div>

      {/* ---- the albums we have ---- */}
      <h2 className="mb-2 text-xs font-medium">In the library</h2>
      {artist.albums.length === 0 ? (
        <Callout tone="info" data-testid="artist-no-albums">
          No album is filed under this name. The artist is known from a MusicBrainz lookup, but
          nothing of theirs has been placed yet.
        </Callout>
      ) : (
        <div
          data-testid="artist-albums"
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 xl:grid-cols-6"
        >
          {artist.albums.map((album) => (
            <AlbumCard
              key={album.id}
              album={album}
              score={album.quality.score}
              currentSchema={artist.currentSchema}
              showArtist={false}
            />
          ))}
        </div>
      )}

      {/* ---- the discography, against MusicBrainz ---- */}
      <div className="mt-6 mb-2 flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-xs font-medium">MusicBrainz discography</h2>
        {artist.mbid === null ? null : (
          <Button
            size="sm"
            variant="outline"
            disabled={comparing}
            data-testid="artist-compare"
            onClick={compare}
          >
            <RefreshCw className="size-3.5" aria-hidden="true" />
            {known === null ? "Compare with MusicBrainz" : "Refresh the comparison"}
          </Button>
        )}
      </div>

      {artist.mbid === null ? (
        <Callout tone="info" data-testid="artist-no-mbid">
          This artist has no MusicBrainz id, so there is no discography to compare against. One
          arrives the first time an import of theirs is matched to a MusicBrainz release.
        </Callout>
      ) : known === null ? (
        <Callout tone="neutral" data-testid="artist-shelf-empty">
          Not compared yet. The comparison is one MusicBrainz request for the whole discography; it
          is kept in the raw cache afterwards, so this section costs nothing on every later visit.
          Press <span className="font-medium">Compare with MusicBrainz</span> to spend it.
        </Callout>
      ) : (
        <div className="rounded-xl border border-line bg-surface-1" data-testid="artist-shelf">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
            <ToneBadge tone={known.missing.length === 0 ? "ok" : "warn"}>
              you have {known.have} of {known.total}
            </ToneBadge>
            <span className="text-2xs text-fg-3">
              from MusicBrainz, {dateTime(known.fetchedAt)}
              {known.stale ? " · stale" : ""} · counting the release types Settings › Discover
              includes
            </span>
          </header>
          {known.missing.length === 0 ? (
            <p className="px-3 py-3 text-xs text-fg-2">
              Nothing missing: every release group MusicBrainz credits them with is in the library.
            </p>
          ) : (
            <ul className="divide-y divide-line">
              {known.missing.map((group) => (
                <li
                  key={group.rgMbid}
                  data-testid="artist-missing-release"
                  className="flex flex-wrap items-center gap-2 px-3 py-2"
                >
                  <Disc3 className="size-3.5 shrink-0 text-fg-3" aria-hidden="true" />
                  <span className="min-w-0 grow truncate text-xs font-medium">{group.title}</span>
                  <span className="text-2xs text-fg-3">
                    {group.year === null ? "year unknown" : group.year} · {group.primaryType}
                    {group.secondaryTypes.length === 0
                      ? ""
                      : ` · ${group.secondaryTypes.join(", ")}`}
                  </span>
                  <MbLink kind="release-group" mbid={group.rgMbid} label="MusicBrainz" />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={importing !== null}
                    aria-label={`Start an import for ${group.title}`}
                    data-testid="artist-import-missing"
                    onClick={() => {
                      startImport(group.rgMbid, group.title);
                    }}
                  >
                    {importing === group.rgMbid ? "Looking…" : "Import…"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </>
  );
}
