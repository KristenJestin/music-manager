/**
 * The resolvers: raw source JSON → document fields.
 *
 * Every one of them is pure — same input, same patch, no clock, no network, no filesystem.
 * That is what makes §8's promise work: the raw cache is kept for ever, so any future field
 * is one resolver away, computed offline from responses we already have.
 *
 * `SOURCE_PRECEDENCE` is the order `merge` resolves conflicts in. MusicBrainz first because
 * it is the editorial source; the measured values (rsgain, AcoustID) and our own namespace
 * come next because nothing else can produce them; YouTube last because its description is a
 * heuristic. `user` is above everything, but a hand-entered value is also locked, and a lock
 * already beats every precedence rule.
 */

import type { SourceId } from "../document.ts";

export { fromAcoustId, bestAcoustIdResult, acoustIdRecordingIds } from "./acoustid.ts";
export type { AcoustIdOptions, AcoustIdResponse, AcoustIdResult } from "./acoustid.ts";

export { fromApp } from "./app.ts";
export type { AppProvenance } from "./app.ts";

export { describeCoverArtOrigin, fromCoverArtArchiveIndex } from "./coverartarchive.ts";
export type { CaaImage, CaaIndex, CoverArtOrigin } from "./coverartarchive.ts";

export { fromDeezerTrack } from "./deezer.ts";
export type { DeezerTrack } from "./deezer.ts";

export { countedTags as lastfmCountedTags, fromLastfmTags } from "./lastfm.ts";
export type { LastfmOptions, LastfmTagInput } from "./lastfm.ts";

export { countedTags as listenBrainzCountedTags, fromListenBrainzTags } from "./listenbrainz.ts";
export type { ListenBrainzOptions, ListenBrainzTagInput } from "./listenbrainz.ts";

export { chooseLrclibEntry, fromLrclib } from "./lrclib.ts";
export type { LrclibEntry, LrclibOptions } from "./lrclib.ts";

export {
  fromMusicBrainzArtist,
  fromMusicBrainzRecording,
  fromMusicBrainzRelease,
  fromMusicBrainzWork,
} from "./musicbrainz.ts";
export type { ArtistResolverOptions, MbArtistLike, ReleaseResolverOptions } from "./musicbrainz.ts";

export {
  genresFromTags,
  isGenreTag,
  isMoodTag,
  MOOD_VOCABULARY,
  moodsFromTags as moodsFromCountedTags,
  titleCase,
} from "./vocabulary.ts";
export type { CountedTag } from "./vocabulary.ts";

export { topGenres } from "./musicbrainz-types.ts";
export type {
  MbArtist,
  MbArtistCreditEntry,
  MbCoverArtArchive,
  MbMedium,
  MbRecording,
  MbRelation,
  MbRelease,
  MbReleaseGroup,
  MbTrack,
  MbWork,
} from "./musicbrainz-types.ts";

export { fromRsgain } from "./rsgain.ts";
export type { RsgainOptions, RsgainResult } from "./rsgain.ts";

export { fromYouTubeEntry } from "./youtube.ts";
export type { YouTubeResolverOptions, YtdlpEntry } from "./youtube.ts";

export { creditFromRelation, creditsFromRelations } from "./relations.ts";
export { PatchBuilder } from "./patch.ts";

/**
 * Default conflict order for `merge` — earlier wins.
 *
 * The genre chain of §4 — MusicBrainz, then Last.fm, then ListenBrainz — is this list, not a
 * special case somewhere: the two folksonomy sources sit below MusicBrainz, so they can only
 * ever fill a `GENRE` that MusicBrainz left missing.
 */
export const SOURCE_PRECEDENCE: readonly SourceId[] = Object.freeze([
  "user",
  "musicbrainz",
  "coverartarchive",
  "acoustid",
  "rsgain",
  "lrclib",
  "deezer",
  "lastfm",
  "listenbrainz",
  "wikimedia",
  "app",
  "youtube",
]);
