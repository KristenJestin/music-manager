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
  /* matching */
  "safeThreshold",
  "titleMatchThreshold",
  "matchAmbiguityMargin",
  "matchBindingFloor",
  "matchDurationTolerance",
  "matchLookupLimit",
  "matchSearchLimit",
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

/** True when `key` belongs to the tab. The save handlers refuse anything else. */
export function inGroup(group: readonly SettingKey[], key: string): key is SettingKey {
  return (group as readonly string[]).includes(key);
}

/** Every key of the registry that no tab shows. Printed by `mm settings list --orphans`. */
export function ungroupedKeys(): SettingKey[] {
  const shown = new Set<string>([...GENERAL_KEYS, ...METADATA_KEYS]);
  return SETTING_KEYS.filter((key) => !shown.has(key));
}
