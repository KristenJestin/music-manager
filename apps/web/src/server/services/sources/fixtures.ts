/**
 * The offline source of truth for `MM_FIXTURES=1`.
 *
 * P03 has no metadata sources yet — P04 brings MusicBrainz, Cover Art Archive, LRCLIB and
 * Deezer. Until then the recorded responses of `packages/domain/fixtures/` stand in for them,
 * which is what makes the whole vertical slice runnable with the network unplugged: the same
 * resolvers, the same document, the same projection, only the bytes come from disk.
 *
 * The scenario is Daft Punk — Discovery: fourteen tracks, fifteen videos. Videos 1–14 bind to
 * tracks 1–14 and video 15 ("One More Time (Radio Edit)") is the `extra_videos` case, so the
 * mapping the `match` stub returns exercises both outcomes without a matcher existing yet.
 *
 * This mirrors `packages/domain/src/testing/discovery.ts`, which is test support and is
 * deliberately not exported from the package; the loading is repeated here rather than
 * reaching into another workspace's internals.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import {
  chooseLrclibEntry,
  resolveTrackDocument,
  TAG_SCHEMA_VERSION,
  type AcoustIdResponse,
  type CaaIndex,
  type DeezerTrack,
  type LrclibEntry,
  type MbRecording,
  type MbRelease,
  type MbWork,
  type TrackDocument,
  type YtdlpEntry,
} from "@mm/domain";
import { APP_VERSION } from "#/server/version.ts";

/** `packages/domain/fixtures/`, six directories up from this file. */
const FIXTURE_ROOT = resolve(
  fileURLToPath(new URL(".", import.meta.url)),
  "../../../../../../packages/domain/fixtures",
);

const cache = new Map<string, unknown>();

function readFixture<T>(relative: string): T {
  const hit = cache.get(relative);
  if (hit !== undefined) return hit as T;
  const parsed = JSON.parse(readFileSync(resolve(FIXTURE_ROOT, relative), "utf8")) as T;
  cache.set(relative, parsed);
  return parsed;
}

interface RsgainScan {
  readonly tracks: readonly {
    readonly trackGain?: string;
    readonly trackPeak?: string;
    readonly albumGain?: string;
    readonly albumPeak?: string;
  }[];
}

/** The recorded release, and the entities that hang off it. */
export function discoveryRelease(): MbRelease {
  return readFixture<MbRelease>("musicbrainz/release-discovery.json");
}

/** One video of a source listing, bound to one MusicBrainz track. */
export interface FixtureMapping {
  /** Index of the video in the source listing, as the toolbox numbered it. */
  readonly position: number;
  readonly trackPosition: number;
  readonly mediumPosition: number;
  readonly trackMbid: string;
  readonly recordingMbid: string;
  readonly trackTitle: string;
  readonly confidence: number;
}

export interface FixtureMatch {
  readonly releaseMbid: string;
  readonly releaseGroupMbid: string | null;
  readonly album: string;
  readonly albumArtist: string;
  readonly year: number | null;
  /** Tracks on the release, so `uncovered_tracks` is detectable. */
  readonly trackTotal: number;
  readonly mapping: readonly FixtureMapping[];
  /** Video indexes that no track claimed — `extra_videos` (`docs/04` § Inbox). */
  readonly extras: readonly number[];
}

/** True when a submitted URL is one this module can answer for. */
export function isDiscoveryFixture(url: string): boolean {
  return url.trim().toLowerCase().startsWith("fixture://discovery");
}

/**
 * The mapping the `match` stub returns for `fixture://discovery`.
 *
 * Positional, on purpose: P05 replaces this with the scored 1:1 assignment of `docs/04`, and
 * a stub that pretended to score would only make that replacement harder to review.
 */
export function matchDiscovery(videoCount: number): FixtureMatch {
  const release = discoveryRelease();
  const medium = release.media?.[0];
  const tracks = medium?.tracks ?? [];

  const mapping: FixtureMapping[] = [];
  for (const track of tracks) {
    // A recorded release always numbers its tracks; a defensive skip is cheaper than an
    // exception thrown from inside a step that has already written half a job.
    if (track.position === undefined) continue;
    const position = track.position - 1;
    if (position >= videoCount) continue;
    mapping.push({
      position,
      trackPosition: track.position,
      mediumPosition: medium?.position ?? 1,
      trackMbid: track.id ?? "",
      recordingMbid: track.recording?.id ?? "",
      trackTitle: track.title ?? "",
      confidence: 1,
    });
  }

  const claimed = new Set(mapping.map((entry) => entry.position));
  const extras = Array.from({ length: videoCount }, (_, index) => index).filter(
    (index) => !claimed.has(index),
  );

  const year = release.date === undefined ? null : Number(release.date.slice(0, 4));
  return {
    releaseMbid: release.id ?? "",
    releaseGroupMbid: release["release-group"]?.id ?? null,
    album: release.title ?? "",
    albumArtist: release["artist-credit"]?.map((credit) => credit.name ?? "").join(" & ") ?? "",
    year: year === null || Number.isNaN(year) ? null : year,
    trackTotal: tracks.length,
    mapping,
    extras,
  };
}

/** The loudness figures of a completed `/replaygain` scan, in rsgain's own formatting. */
export interface MeasuredLoudness {
  readonly trackGain?: string;
  readonly trackPeak?: string;
  readonly albumGain?: string;
  readonly albumPeak?: string;
  readonly referenceLoudness?: string;
  readonly r128TrackGain?: number;
  readonly r128AlbumGain?: number;
}

export interface DocumentInput {
  readonly trackPosition: number;
  readonly importId: string;
  readonly sourceUrl: string;
  /** The `ExtractEntry` the toolbox returned for this video, as a yt-dlp entry. */
  readonly entry: YtdlpEntry;
  readonly fetchedAt: string;
  readonly importedOn: string;
  readonly loudness?: MeasuredLoudness;
  readonly opus: boolean;
}

/**
 * Build one track's document from the recorded sources.
 *
 * Track 1 has the full set (a standalone recording lookup, its work, LRCLIB, AcoustID);
 * the others use the recording embedded in the release, which is what a single release
 * lookup really returns. Track 6 is the album's instrumental, so LRCLIB's `instrumental`
 * flag is applied to it — that is the case that must leave `LYRICS` n/a rather than missing.
 */
export function buildDocument(input: DocumentInput): TrackDocument {
  const release = discoveryRelease();
  const medium = release.media?.[0];
  const track = (medium?.tracks ?? []).find(
    (candidate) => candidate.position === input.trackPosition,
  );
  const embedded = track?.recording;

  const isFirst = input.trackPosition === 1;
  const isInstrumental = input.trackPosition === 6;

  const recording: MbRecording | undefined = isFirst
    ? readFixture<MbRecording>("musicbrainz/recording-one-more-time.json")
    : embedded;

  const lyrics = isFirst
    ? chooseLrclibEntry(readFixture<LrclibEntry[]>("lrclib/search-one-more-time.json"), {
        durationSeconds: 320,
      })
    : isInstrumental
      ? readFixture<LrclibEntry>("lrclib/get-instrumental.json")
      : undefined;

  return resolveTrackDocument({
    release: {
      data: release,
      fetchedAt: input.fetchedAt,
      trackPosition: input.trackPosition,
      ...(medium?.position === undefined ? {} : { mediumPosition: medium.position }),
    },
    ...(recording === undefined
      ? {}
      : { recording: { data: recording, fetchedAt: input.fetchedAt } }),
    ...(isFirst
      ? {
          work: {
            data: readFixture<MbWork>("musicbrainz/work-one-more-time.json"),
            fetchedAt: input.fetchedAt,
          },
          acoustId: {
            data: readFixture<AcoustIdResponse>("acoustid/lookup-one-more-time.json"),
            fetchedAt: input.fetchedAt,
          },
        }
      : {}),
    coverArt: {
      data: readFixture<CaaIndex>("coverartarchive/release-discovery.json"),
      fetchedAt: input.fetchedAt,
    },
    ...(lyrics === undefined ? {} : { lyrics: { data: lyrics, fetchedAt: input.fetchedAt } }),
    deezer: {
      data: readFixture<DeezerTrack>("deezer/track-one-more-time.json"),
      fetchedAt: input.fetchedAt,
    },
    youtube: {
      data: input.entry,
      fetchedAt: input.fetchedAt,
      appVersion: APP_VERSION,
      importedOn: input.importedOn,
    },
    ...(input.loudness === undefined
      ? {}
      : { rsgain: { data: input.loudness, fetchedAt: input.fetchedAt, opus: input.opus } }),
    app: {
      importId: input.importId,
      sourceUrl: input.sourceUrl,
      tagSchemaVersion: TAG_SCHEMA_VERSION,
      fetchedAt: input.fetchedAt,
    },
  });
}

/** The recorded rsgain scan, used only when the real files cannot be measured. */
export function recordedLoudness(trackPosition: number): MeasuredLoudness | undefined {
  const scan = readFixture<RsgainScan>("rsgain/scan-discovery.json");
  return scan.tracks[trackPosition - 1];
}
