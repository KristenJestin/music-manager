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

export { fromCoverArtArchiveIndex } from "./coverartarchive.ts";
export type { CaaImage, CaaIndex } from "./coverartarchive.ts";

export { fromDeezerTrack } from "./deezer.ts";
export type { DeezerTrack } from "./deezer.ts";

export { chooseLrclibEntry, fromLrclib } from "./lrclib.ts";
export type { LrclibEntry, LrclibOptions } from "./lrclib.ts";

export {
  fromMusicBrainzRecording,
  fromMusicBrainzRelease,
  fromMusicBrainzWork,
} from "./musicbrainz.ts";
export type { ReleaseResolverOptions } from "./musicbrainz.ts";

export type {
  MbArtist,
  MbArtistCreditEntry,
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

/** Default conflict order for `merge` — earlier wins. */
export const SOURCE_PRECEDENCE: readonly SourceId[] = Object.freeze([
  "user",
  "musicbrainz",
  "coverartarchive",
  "acoustid",
  "rsgain",
  "lrclib",
  "deezer",
  "app",
  "youtube",
]);
