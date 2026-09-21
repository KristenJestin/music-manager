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
  fromMusicBrainzPseudoRelease,
  fromMusicBrainzRecording,
  fromMusicBrainzRelease,
  fromMusicBrainzWork,
  fromRsgain,
  fromYouTubeEntry,
  SOURCE_PRECEDENCE,
  type AcoustIdOptions,
  type AcoustIdResponse,
  type AppProvenance,
  type ArtistNameSource,
  type CaaIndex,
  type CoverArtOrigin,
  type DeezerTrack,
  type LastfmTagInput,
  type ListenBrainzTagInput,
  type LocalePreference,
  type LrclibEntry,
  type MbRecording,
  type MbRelease,
  type MbWork,
  type RsgainResult,
  type YouTubeResolverOptions,
  type YtdlpEntry,
} from "./resolvers/index.ts";
import { DEFAULT_WRITE_WORK_TAGS, isClassicalRelease, type WriteWorkTags } from "./classical.ts";
import {
  classicalShapeOf,
  releaseGenreNames,
  type MbArtistLike,
  type WorkTagOptions,
} from "./resolvers/musicbrainz.ts";
import { performedWork } from "./resolvers/relations.ts";
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
  /**
   * The Latin pseudo-release of the same release group, when one was found and the setting
   * asked for it. It only ever overwrites `ALBUM`, `ALBUMSORT`, `TITLE` and `TITLESORT`; see
   * `fromMusicBrainzPseudoRelease`.
   */
  readonly pseudoRelease?: Cached<MbRelease> & {
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
  /**
   * Which of MusicBrainz's two artist names goes into ARTIST / ARTISTS / ALBUMARTIST:
   * the one credited on the release, or the artist's canonical one. Defaults to `credited`.
   */
  readonly artistNameSource?: ArtistNameSource;
  /**
   * Picard's “translate names to this locale”: the artist and album names are taken from the
   * MusicBrainz alias of that locale, the originals stay in the sort fields. Absent — the
   * default — is the behaviour that existed before the feature, tag for tag.
   */
  readonly locale?: LocalePreference;
  /**
   * What happens to the work fields — `WORK` and §2.4's movement block — on this release
   * (issue #4, D4-03). `classical`, the default, writes them on classical releases only;
   * `always` restores the old behaviour, `never` writes none of them.
   */
  readonly writeWorkTags?: WriteWorkTags;
}

export function resolveTrackDocument(input: TrackResolutionInput): TrackDocument {
  const patches: DocumentPatch[] = [];

  // Whether the work fields are written is a property of the *release*, not of the entity that
  // happens to carry the work: the release group's genres and the work's shape decide it once,
  // here, and both resolvers below are told the answer.
  //
  // The work reaches us twice, and the two copies are not equivalent: `input.work` is the copy
  // the pipeline asked for on its own (`workFull`, no `work-rels`), the recording's relation is
  // the copy MusicBrainz nested with `work-level-rels` — where the movements, `parts`, live.
  // The preferred copy gives the title and the credits, the shape reads whichever copy carries
  // each half (review of pull request #14, point 1: it used to read the preferred one only, so
  // the movement half was dead whenever a work had been fetched separately).
  const nestedWork = performedWork(input.recording?.data.relations)?.work;
  const workOfTrack = input.work?.data ?? nestedWork;
  const workTags: WorkTagOptions = {
    writeWorkTags: input.writeWorkTags ?? DEFAULT_WRITE_WORK_TAGS,
    classical: isClassicalRelease({
      genres: releaseGenreNames(input.release?.data),
      work: classicalShapeOf(workOfTrack, nestedWork),
    }),
  };

  if (input.youtube !== undefined) {
    const { data, fetchedAt, ...options } = input.youtube;
    patches.push(fromYouTubeEntry(data, { ...options, fetchedAt }));
  }
  if (input.release !== undefined) {
    const { data, fetchedAt, mediumPosition, trackPosition } = input.release;
    patches.push(
      fromMusicBrainzRelease(data, {
        mediumPosition,
        trackPosition,
        fetchedAt,
        ...(input.artistNameSource === undefined
          ? {}
          : { artistNameSource: input.artistNameSource }),
        ...(input.locale === undefined ? {} : { locale: input.locale }),
      }),
    );
  }
  if (input.recording !== undefined) {
    patches.push(
      fromMusicBrainzRecording(input.recording.data, {
        fetchedAt: input.recording.fetchedAt,
        ...(input.artistNameSource === undefined
          ? {}
          : { artistNameSource: input.artistNameSource }),
        ...(input.locale === undefined ? {} : { locale: input.locale }),
        ...workTags,
      }),
    );
  }
  // After the release *and* the recording, both of which set `TITLE`: the pseudo-release is a
  // spelling of what they said, so it must be the last MusicBrainz word on the four names it
  // owns. Equal source, equal confidence — `merge` then keeps the later patch.
  if (input.pseudoRelease !== undefined) {
    const { data, fetchedAt, mediumPosition, trackPosition } = input.pseudoRelease;
    patches.push(
      fromMusicBrainzPseudoRelease(
        data,
        {
          album: input.release?.data.title,
          title: trackOf(input.release, mediumPosition, trackPosition),
        },
        {
          ...(mediumPosition === undefined ? {} : { mediumPosition }),
          trackPosition,
          fetchedAt,
        },
      ),
    );
  }
  if (input.work !== undefined) {
    patches.push(
      fromMusicBrainzWork(input.work.data, { fetchedAt: input.work.fetchedAt, ...workTags }),
    );
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

/** The original title of the track a pseudo-release is about to rename — for `TITLESORT`. */
function trackOf(
  release: TrackResolutionInput["release"],
  mediumPosition: number | undefined,
  trackPosition: number,
): string | undefined {
  const media = release?.data.media ?? [];
  const medium =
    mediumPosition === undefined
      ? media[0]
      : media.find((candidate) => candidate.position === mediumPosition);
  const track = (medium?.tracks ?? []).find((candidate) => candidate.position === trackPosition);
  return track?.title ?? track?.recording?.title;
}

function lockAll(fields: Readonly<Record<string, Field>>): Record<string, Field> {
  return Object.fromEntries(
    Object.entries(fields).map(([name, held]) => [name, { ...held, locked: true }]),
  );
}
