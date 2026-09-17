/**
 * Which settings each Settings tab owns, and how to test the ones that talk to somebody.
 *
 * The registry in `settings.service` is one flat list of typed knobs, which is right for the
 * CLI and for the worker. A *page* needs a subset with an order, so the subsets live here —
 * one array per tab, referencing the same keys. Nothing is duplicated: the schema, the
 * default and the sentence explaining a key still exist in exactly one place, and a key added
 * to the registry but to no group simply does not appear in the Console until somebody puts
 * it on a tab, which is a visible omission rather than a silent one.
 *
 * `settings-groups.test.ts` asserts every key here exists, so a rename that misses this file
 * is a failing test rather than a page that silently drops a field.
 */
import { SETTING_KEYS, type SettingKey } from "#/server/services/settings.ts";

/** Settings › Library & files. Where files go, and what rides next to them. */
export const GENERAL_KEYS = [
  "libraryRoot",
  "toolboxLibraryRoot",
  "pathTemplate",
  "discMode",
  "sanitizeMode",
  "maxSegmentLength",
  "onExists",
  "writeCover",
  "writeArtistImage",
  "writeLyricsSidecar",
  "embedArtwork",
  "artworkSize",
  "downloadFormat",
  "replayGain",
  "replayGainReferenceLoudness",
] as const satisfies readonly SettingKey[];

/** Settings › Metadata & matching. Everything that decides what a tag says. */
export const METADATA_KEYS = [
  /* MusicBrainz */
  "mbContact",
  "preferredLocale",
  "aliasTranslateArtists",
  "aliasTranslateAlbums",
  "aliasTranslateOnlyNonLatin",
  "aliasPseudoRelease",
  /* matching */
  "safeThreshold",
  "titleMatchThreshold",
  "matchPreselectionFloor",
  "matchAmbiguityMargin",
  "matchBindingFloor",
  "matchDurationTolerance",
  "matchLookupLimit",
  "matchSearchLimit",
  "matchGroupLimit",
  "matchReleaseWeights",
  "matchRecordingWeights",
  "matchMappingWeights",
  "preferredCountries",
  "preferredFormat",
  "explicitPreference",
  "learnPreferences",
  "learnedFrom",
  /* fingerprint */
  "verifyFingerprint",
  "fingerprintMinScore",
  "acoustidKey",
  "writeAcoustidFingerprint",
  /* enrichment */
  "artistNameSource",
  "coverOrder",
  "coverMaxBytes",
  "genrePreference",
  "maxGenres",
  "genreMinCount",
  "lyricsMaxDurationDelta",
  "lastfmKey",
  "fanartKey",
  /* sources */
  "sourcesEnabled",
  "sourceTtlDays",
  "sourcesRefreshEnabled",
  /* tag schema */
  "tagSchemaVersionOverride",
  "retagBatchSize",
] as const satisfies readonly SettingKey[];

/**
 * Settings › Discover. What the recommendations are computed from, and how many (P09).
 *
 * `lastfmKey` is here **and** in `METADATA_KEYS`, deliberately. A group is a view over the
 * registry, not an owner: the key enriches genres during an import (Metadata) and it is the
 * similar-artist source Discover falls back to when ListenBrainz is silent, so hiding it from
 * one of the two tabs makes that tab lie about why a block is empty. `ungroupedKeys()` folds
 * the groups into a set, so an overlap costs nothing there; the two save handlers each accept
 * their own group, so either tab can write it.
 */
export const DISCOVER_KEYS = [
  "discoverEnabled",
  "discoverCron",
  "discoverWindowDays",
  "discoverTopArtists",
  "discoverMaxItems",
  "discoverMaxPerArtist",
  "discoverIncludeTypes",
  "discoverExcludeLive",
  "discoverExcludeCompilations",
  "listenbrainzUser",
  "lastfmKey",
  "discoverPlaylistEnabled",
  "discoverPlaylistName",
] as const satisfies readonly SettingKey[];

/**
 * Settings › Watched sources. What may be imported at all, when the scan runs, and what a
 * scan may confirm alone.
 *
 * The two admission rules lead, and they belong on this tab rather than on Metadata & matching
 * even though they apply to every import path: they decide whether a URL becomes a job, not
 * what a tag ends up saying. `officialUploadsOnly` is also the installation-wide form of the
 * per-source `requireProvidedToYouTube` switch on `/sources`, so the two are one search apart.
 */
export const WATCHED_SOURCES_KEYS = [
  "officialUploadsOnly",
  "requireAlbum",
  "watchedSourcesEnabled",
  "watchedSourcesCron",
  "watchedSourcesAutoAcceptDefault",
  "watchedSourcesAutoAcceptThreshold",
] as const satisfies readonly SettingKey[];

/** True when `key` belongs to the tab. The save handlers refuse anything else. */
export function inGroup(group: readonly SettingKey[], key: string): key is SettingKey {
  return (group as readonly string[]).includes(key);
}

/** Every key of the registry that no tab shows. Printed by `mm settings list --orphans`. */
export function ungroupedKeys(): SettingKey[] {
  const shown = new Set<string>([
    ...GENERAL_KEYS,
    ...METADATA_KEYS,
    ...DISCOVER_KEYS,
    ...WATCHED_SOURCES_KEYS,
  ]);
  return SETTING_KEYS.filter((key) => !shown.has(key));
}
