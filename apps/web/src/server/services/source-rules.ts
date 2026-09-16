/**
 * Admission rules — what a source has to look like before it is allowed to become an import.
 *
 * Two switches, both off by default so nothing changes for an installation that never asked
 * for them, and both asked of the **description** rather than of the channel. That is not a
 * preference, it is the measurement: on the owner's 9766 real sources the
 * "Provided to YouTube by" line is present on 9544 and absent on 222, while the channel name
 * is *empty* on 5306 of them and carries the `- Topic` suffix on only 580. A rule written
 * against the channel would refuse more than half the library.
 *
 * The detection itself is not written here. `hasProvidedToYouTube` lives in
 * `packages/domain/src/normalize/youtube-description.ts`, next to the parser that has always
 * looked for the same line to decide whether a description is auto-generated at all — one
 * string, one place, one casing rule. A second copy would be a second thing to keep true, and
 * the one that used to exist (`watched-sources.ts`, case-sensitive) is gone.
 *
 * The verdict shape is `watched-sources.ts`'s `FilterVerdict`, deliberately: "why was this
 * skipped?" has to be a sentence somebody can read off a row days later, not a branch they
 * have to re-derive. What differs is that a verdict here also carries the typed error code the
 * refusal of a *single* URL is raised with, because the same rule has to be able to be either
 * a skip or a refusal depending on what the URL turned out to be.
 */
import { MMError, type MMErrorCode } from "@mm/contracts";
import { hasProvidedToYouTube, parseYouTubeDescription } from "@mm/domain";
import type { Settings } from "#/server/services/settings.ts";

/** Everything a rule reads off one video. Structural, so a test needs no toolbox fixture. */
export interface SourceEntry {
  readonly description?: string | null;
  /** The YouTube Music `album` tag, the same field `resolve` classifies an album on. */
  readonly album?: string | null;
}

/** The two switches, lifted out of the settings so the pure part stays pure. */
export interface SourceRules {
  readonly officialUploadsOnly: boolean;
  readonly requireAlbum: boolean;
}

export function sourceRulesOf(settings: Settings): SourceRules {
  return {
    officialUploadsOnly: settings.officialUploadsOnly,
    requireAlbum: settings.requireAlbum,
  };
}

/**
 * `{accept, reason}` as the watched-source scan already writes it, plus the code the single-URL
 * path raises. `code` is `null` on an acceptance, because there is nothing to name.
 */
export interface AdmissionVerdict {
  readonly accept: boolean;
  readonly reason: string;
  readonly code: MMErrorCode | null;
}

const ACCEPTED: AdmissionVerdict = { accept: true, reason: "", code: null };

/**
 * Is this video a distributor's own upload?
 *
 * The one question `officialUploadsOnly` asks, exported on its own because the API answers it
 * before an import exists (`GET /api/v1/tools/url`).
 */
export function isOfficialUpload(entry: SourceEntry): boolean {
  return hasProvidedToYouTube(entry.description);
}

/**
 * The album this video says it belongs to, or `null` when nothing does.
 *
 * **This is the definition of "no album attached"**, and it is the same pair of sources
 * `resolve` and `albumHints` already read, in the same order of trust:
 *
 *  1. the YouTube Music `album` tag on the entry — the field `classify()` counts to decide
 *     between `album` and `playlist`, so a rule that ignored it would disagree with the kind
 *     the very same step writes;
 *  2. failing that, the album line of the auto-generated description, which is where the tag
 *     comes from in the first place and which survives on videos whose tags yt-dlp did not
 *     surface.
 *
 * Whitespace is not an album: `" "` is `null`, because YouTube does emit empty tags.
 */
export function attachedAlbum(entry: SourceEntry): string | null {
  const tag = (entry.album ?? "").trim();
  if (tag !== "") return tag;
  const album = (parseYouTubeDescription(entry.description)?.album ?? "").trim();
  return album === "" ? null : album;
}

/**
 * Should this video become (or stay part of) an import?
 *
 * `isolated` is what `resolve` classified: `true` for a lone video — `kind` `single`, one
 * entry — and `false` for an entry inside a playlist or an album. Only `requireAlbum` cares:
 * it is a rule about importing a track with nowhere to file it, and an entry that arrives
 * inside a playlist is never in that position, because the playlist is the album.
 */
export function admit(
  entry: SourceEntry,
  rules: SourceRules,
  options: { readonly isolated: boolean },
): AdmissionVerdict {
  if (rules.officialUploadsOnly && !isOfficialUpload(entry)) {
    return {
      accept: false,
      reason: "No “Provided to YouTube by” line in the description — not a distributor's upload",
      code: "SOURCE_NOT_OFFICIAL",
    };
  }
  if (rules.requireAlbum && options.isolated && attachedAlbum(entry) === null) {
    return {
      accept: false,
      reason: "No album attached — neither a YouTube Music album tag nor an album line",
      code: "SOURCE_NO_ALBUM",
    };
  }
  return ACCEPTED;
}

/**
 * The same verdict as the error a single URL is refused with.
 *
 * Never a silent drop: a person who pasted one link and got back an import that resolved to
 * nothing would have to guess. The hint names the setting by the name the Console shows, so
 * turning the rule off is one search away.
 */
export function refusalOf(verdict: AdmissionVerdict, url: string): MMError {
  const officialUploads = verdict.code === "SOURCE_NOT_OFFICIAL";
  return new MMError(
    verdict.code ?? "INVALID_INPUT",
    officialUploads
      ? `“${url}” has no “Provided to YouTube by” line in its description, and “Official uploads only” is on.`
      : `“${url}” is a video with no album attached, and “Require an album” is on.`,
    {
      hint: officialUploads
        ? "That line is what a distributor writes on an official upload; a video without it is " +
          "usually a rip, a cover or somebody talking. Turn “Official uploads only” off in " +
          "Settings › Watched sources to import it anyway."
        : "An isolated video with neither a YouTube Music album tag nor an album line in its " +
          "description has nowhere to be filed. Turn “Require an album” off in " +
          "Settings › Watched sources to import it anyway.",
      action: "Change the rule",
      details: { url, rule: officialUploads ? "officialUploadsOnly" : "requireAlbum" },
      status: 422,
    },
  );
}
