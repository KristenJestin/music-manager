/**
 * One track's document, assembled from the raw cache.
 *
 * This is the recomputable step of `docs/03-metadonnees.md` §1: give it the source responses
 * that were stored (never purged, §8) and it returns the document. No network, no clock, no
 * randomness — the same cache always produces the same document, which is exactly what makes
 * the background re-tag safe and the golden files meaningful.
 *
 * Locked values are applied last so nothing a resolver produces can take them back.
 */

import { merge, type DocumentPatch, type Field, type TrackDocument } from "./document.ts";
import {
  fromAcoustId,
  fromApp,
  fromCoverArtArchiveIndex,
  fromDeezerTrack,
  fromLastfmTags,
  fromListenBrainzTags,
  fromLrclib,
  fromMusicBrainzArtist,
  fromMusicBrainzRecording,
  fromMusicBrainzRelease,
  fromMusicBrainzWork,
  fromRsgain,
  fromYouTubeEntry,
  SOURCE_PRECEDENCE,
  type AcoustIdOptions,
  type AcoustIdResponse,
  type AppProvenance,
  type CaaIndex,
  type CoverArtOrigin,
  type DeezerTrack,
  type LastfmTagInput,
  type ListenBrainzTagInput,
  type LrclibEntry,
  type MbRecording,
  type MbRelease,
  type MbWork,
  type RsgainResult,
  type YouTubeResolverOptions,
  type YtdlpEntry,
} from "./resolvers/index.ts";
import type { MbArtistLike } from "./resolvers/musicbrainz.ts";
import { TAG_SCHEMA_VERSION } from "./schema.ts";

/** A cached response plus the instant it was fetched — one entry of the raw cache. */
export interface Cached<T> {
  readonly data: T;
  readonly fetchedAt: string;
}

export interface TrackResolutionInput {
  readonly release?: Cached<MbRelease> & {
    readonly mediumPosition?: number;
    readonly trackPosition: number;
  };
  readonly recording?: Cached<MbRecording>;
  readonly work?: Cached<MbWork>;
  /** The credited artists, looked up on their own — the only source of `WEBSITE` (§2.2). */
  readonly artists?: readonly Cached<MbArtistLike>[];
  /**
   * The Cover Art Archive index, plus **which rung of the §4 ladder answered it** — this
   * release, its release group, or a sibling release (decision 168). The rung ends up in the
   * picture's `provenance`, because `source` says `coverartarchive` for all three.
   */
  readonly coverArt?: Cached<CaaIndex> & { readonly origin?: CoverArtOrigin };
  /** The LRCLIB entry already chosen out of a search (see `chooseLrclibEntry`). */
  readonly lyrics?: Cached<LrclibEntry | null>;
  readonly deezer?: Cached<DeezerTrack>;
  readonly acoustId?: Cached<AcoustIdResponse> & Omit<AcoustIdOptions, "fetchedAt">;
  readonly youtube?: Cached<YtdlpEntry> & Omit<YouTubeResolverOptions, "fetchedAt">;
  /** Last.fm top tags, track's first then the artist's — the §4 genre fallback. */
  readonly lastfm?: Cached<readonly LastfmTagInput[]>;
  /** ListenBrainz community tags — the last link of the genre chain. */
  readonly listenbrainz?: Cached<readonly ListenBrainzTagInput[]>;
  /** How many `GENRE` values at most, and the vote floor under which a tag is noise. */
  readonly tagOptions?: { readonly maxGenres?: number; readonly minCount?: number };
  readonly rsgain?: Cached<RsgainResult> & { readonly opus: boolean };
  /**
   * Patches the caller built itself, applied just before `app` and therefore below every
   * resolver above in `SOURCE_PRECEDENCE`. The YouTube-thumbnail cover fallback of §4 is one:
   * it is not a Cover Art Archive answer, so it cannot travel as one.
   */
  readonly extra?: readonly DocumentPatch[];
  readonly app: Omit<AppProvenance, "fetchedAt"> & { readonly fetchedAt: string };
  /** Values you entered or confirmed. They are locked and win every merge (§1). */
  readonly locked?: Readonly<Record<string, Field>>;
}

export function resolveTrackDocument(input: TrackResolutionInput): TrackDocument {
  const patches: DocumentPatch[] = [];

  if (input.youtube !== undefined) {
    const { data, fetchedAt, ...options } = input.youtube;
    patches.push(fromYouTubeEntry(data, { ...options, fetchedAt }));
  }
  if (input.release !== undefined) {
    const { data, fetchedAt, mediumPosition, trackPosition } = input.release;
    patches.push(fromMusicBrainzRelease(data, { mediumPosition, trackPosition, fetchedAt }));
  }
  if (input.recording !== undefined) {
    patches.push(
      fromMusicBrainzRecording(input.recording.data, { fetchedAt: input.recording.fetchedAt }),
    );
  }
  if (input.work !== undefined) {
    patches.push(fromMusicBrainzWork(input.work.data, { fetchedAt: input.work.fetchedAt }));
  }
  for (const artist of input.artists ?? []) {
    patches.push(fromMusicBrainzArtist(artist.data, { fetchedAt: artist.fetchedAt }));
  }
  if (input.coverArt !== undefined) {
    patches.push(
      fromCoverArtArchiveIndex(input.coverArt.data, {
        fetchedAt: input.coverArt.fetchedAt,
        ...(input.coverArt.origin === undefined ? {} : { origin: input.coverArt.origin }),
      }),
    );
  }
  if (input.lyrics !== undefined) {
    patches.push(fromLrclib(input.lyrics.data, { fetchedAt: input.lyrics.fetchedAt }));
  }
  if (input.deezer !== undefined) {
    patches.push(fromDeezerTrack(input.deezer.data, { fetchedAt: input.deezer.fetchedAt }));
  }
  if (input.acoustId !== undefined) {
    const { data, fetchedAt, ...options } = input.acoustId;
    patches.push(fromAcoustId(data, { ...options, fetchedAt }));
  }
  // The genre chain of §4. Both sit below MusicBrainz in `SOURCE_PRECEDENCE`, so they can
  // only fill a `GENRE` MusicBrainz left missing — the preference is data, not control flow.
  if (input.lastfm !== undefined) {
    patches.push(
      fromLastfmTags(input.lastfm.data, {
        fetchedAt: input.lastfm.fetchedAt,
        limit: input.tagOptions?.maxGenres ?? 3,
        minCount: input.tagOptions?.minCount ?? 0,
      }),
    );
  }
  if (input.listenbrainz !== undefined) {
    patches.push(
      fromListenBrainzTags(input.listenbrainz.data, {
        fetchedAt: input.listenbrainz.fetchedAt,
        limit: input.tagOptions?.maxGenres ?? 3,
        minCount: input.tagOptions?.minCount ?? 0,
      }),
    );
  }
  if (input.rsgain !== undefined) {
    patches.push(
      fromRsgain(input.rsgain.data, { fetchedAt: input.rsgain.fetchedAt, opus: input.rsgain.opus }),
    );
  }

  for (const patch of input.extra ?? []) patches.push(patch);

  patches.push(fromApp({ ...input.app }));

  if (input.locked !== undefined) {
    patches.push({ fields: lockAll(input.locked) });
  }

  return merge(patches, { schemaVersion: TAG_SCHEMA_VERSION, precedence: SOURCE_PRECEDENCE });
}

function lockAll(fields: Readonly<Record<string, Field>>): Record<string, Field> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, held]) => [name, { ...held, locked: true }]),
  );
}
