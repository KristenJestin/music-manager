/**
 * One album, as a cover with the two facts that matter written on it.
 *
 * Lifted out of `/library` unchanged so that `/library/artists/:id` shows the *same* tile
 * rather than a second, slightly different one. The badges are the interesting part and they
 * are easy to get subtly wrong — three states for the track count, not two; a file that has
 * gone is not a track never imported — so they belong in one place.
 *
 * The score is passed in rather than read off `quality`, because the grid can be looking at a
 * profile ("as Navidrome reads it") and the card must not decide that for it.
 */
import { Link } from "@tanstack/react-router";
import { Cover, albumCoverSources } from "#/components/cover.tsx";
import { ToneBadge, scoreTone } from "#/components/status-badge.tsx";
import { SchemaBadge } from "#/components/library/schema.tsx";
import { pct } from "#/lib/format.ts";
import type { AlbumCard as AlbumCardRow } from "#/server/services/library.ts";

export interface AlbumCardProps {
  readonly album: AlbumCardRow;
  /** The completeness to print: the global score, or the one for the selected profile. */
  readonly score: number | null;
  /** `stats.currentSchema` — what "behind schema" is measured against. */
  readonly currentSchema: number;
  /** Shown under the title. `false` on a page that is already about one artist. */
  readonly showArtist?: boolean;
}

export function AlbumCard({ album, score, currentSchema, showArtist = true }: AlbumCardProps) {
  // Three states, not two. An album whose total came from the release (or from tracks that
  // agree on `totaltracks`) can be called incomplete; one whose `track_count` is just our own
  // file count cannot be called anything, and saying `5/5` there is the lie this badge exists
  // to stop.
  const totalKnown = album.quality.totalKnown;
  const incomplete = totalKnown && album.presentCount < album.trackCount;

  return (
    <Link
      to="/library/albums/$id"
      params={{ id: album.id }}
      data-testid="album-card"
      data-album-title={album.title}
      className="group/album flex flex-col gap-1.5"
    >
      <div className="relative">
        {/* The `cover.jpg` this library actually holds, then the Cover Art Archive, then the
            gradient — the same order everywhere an album is drawn (owner review C10). */}
        <Cover
          size="full"
          seed={album.id}
          label={album.title}
          src={albumCoverSources(album, "full")}
        />
        {incomplete ? (
          <ToneBadge tone="warn" className="absolute top-1.5 left-1.5">
            {album.presentCount}/{album.trackCount}
          </ToneBadge>
        ) : null}
        {totalKnown ? null : (
          <ToneBadge
            tone="muted"
            data-testid="album-total-unknown"
            className="absolute top-1.5 left-1.5"
            title="No release and no track totals in the tags: how many tracks this album should have is unknown."
          >
            {album.presentCount}/?
          </ToneBadge>
        )}
        {/*
          A file that has gone, which is not the same as a track never imported (DRIVE-1 §B5):
          the scan writes `missing_at`, so the grid can say it without stat-ing hundreds of
          albums.
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
        {showArtist ? album.albumArtist : null}
        {album.year === null ? "" : `${showArtist ? " · " : ""}${String(album.year)}`}
      </div>
      <div className="flex items-center gap-1.5">
        <ToneBadge tone={scoreTone(score)} title="Metadata completeness">
          {pct(score)}
        </ToneBadge>
        {album.quality.filesBehind > 0 ? (
          <SchemaBadge version={album.quality.schemaVersion} current={currentSchema} />
        ) : null}
      </div>
    </Link>
  );
}
