/**
 * The Discovery scenario, assembled from `fixtures/` — **test support only**.
 *
 * One place builds the documents the golden files, the completeness assertions and the
 * album-scope assertions all work from, so they can never disagree about what "track 1 of
 * Discovery" means. Every timestamp is frozen: a document must be a pure function of the
 * cache, and a wall clock in here would make the golden files flap.
 */

import {
  chooseLrclibEntry,
  type AcoustIdResponse,
  type CaaIndex,
  type DeezerTrack,
  type LrclibEntry,
  type MbRecording,
  type MbRelease,
  type MbWork,
  type RsgainResult,
  type YtdlpEntry,
} from "../metadata/resolvers/index.ts";
import { resolveTrackDocument } from "../metadata/resolve.ts";
import type { TrackDocument } from "../metadata/document.ts";
import { readFixture } from "./fixtures.ts";

/** Frozen instant every fixture is treated as having been fetched at. */
export const FETCHED_AT = "2026-09-05T22:00:00.000Z";
/** Frozen import stamp, so `COMMENT` is stable in the golden files. */
export const IMPORTED_ON = "2026-09-05";
export const IMPORT_ID = "imp_01K4XQ7N8ZC3RB2VMD9T6HFPGA";
export const APP_VERSION = "2.0.0";
export const YTDLP_VERSION = "yt-dlp 2026.08.31";

interface RsgainScan {
  readonly tracks: readonly RsgainResult[];
}

export const release = readFixture<MbRelease>("musicbrainz/release-discovery.json");
export const recording = readFixture<MbRecording>("musicbrainz/recording-one-more-time.json");
export const work = readFixture<MbWork>("musicbrainz/work-one-more-time.json");
export const coverArt = readFixture<CaaIndex>("coverartarchive/release-discovery.json");
export const lrclibResults = readFixture<LrclibEntry[]>("lrclib/search-one-more-time.json");
export const instrumentalLyrics = readFixture<LrclibEntry>("lrclib/get-instrumental.json");
export const deezer = readFixture<DeezerTrack>("deezer/track-one-more-time.json");
export const acoustId = readFixture<AcoustIdResponse>("acoustid/lookup-one-more-time.json");
export const playlist = readFixture<YtdlpEntry[]>("ytdlp/playlist-discovery.json");
export const video = readFixture<YtdlpEntry>("ytdlp/video-one-more-time.json");
export const rsgainScan = readFixture<RsgainScan>("rsgain/scan-discovery.json");

/**
 * Track 1, "One More Time": every source of §4 at once. This is the document the three
 * golden files project, and the one the global completeness assertion scores.
 */
export function oneMoreTime(): TrackDocument {
  return resolveTrackDocument({
    release: { data: release, fetchedAt: FETCHED_AT, trackPosition: 1 },
    recording: { data: recording, fetchedAt: FETCHED_AT },
    work: { data: work, fetchedAt: FETCHED_AT },
    coverArt: { data: coverArt, fetchedAt: FETCHED_AT },
    lyrics: {
      data: chooseLrclibEntry(lrclibResults, { durationSeconds: 320 }),
      fetchedAt: FETCHED_AT,
    },
    deezer: { data: deezer, fetchedAt: FETCHED_AT },
    acoustId: { data: acoustId, fetchedAt: FETCHED_AT },
    youtube: {
      data: video,
      fetchedAt: FETCHED_AT,
      appVersion: APP_VERSION,
      importedOn: IMPORTED_ON,
      ytdlpVersion: YTDLP_VERSION,
    },
    rsgain: { data: rsgainScan.tracks[0] ?? {}, fetchedAt: FETCHED_AT, opus: true },
    app: {
      importId: IMPORT_ID,
      sourceUrl: video.webpage_url ?? "",
      tagSchemaVersion: 1,
      fetchedAt: FETCHED_AT,
    },
  });
}

/**
 * Any track of the album, resolved from the release fixture and its embedded recording. Used
 * for the album-scope checks, where what matters is that the tracks are built the same way.
 */
export function albumTrack(position: number): TrackDocument {
  const medium = release.media?.[0];
  const track = (medium?.tracks ?? []).find((candidate) => candidate.position === position);
  const trackRecording = track?.recording;
  const entry = playlist[position - 1];
  const scan = rsgainScan.tracks[position - 1] ?? {};

  return resolveTrackDocument({
    release: { data: release, fetchedAt: FETCHED_AT, trackPosition: position },
    ...(trackRecording === undefined
      ? {}
      : { recording: { data: trackRecording, fetchedAt: FETCHED_AT } }),
    coverArt: { data: coverArt, fetchedAt: FETCHED_AT },
    deezer: { data: deezer, fetchedAt: FETCHED_AT },
    ...(entry === undefined
      ? {}
      : {
          youtube: {
            data: entry,
            fetchedAt: FETCHED_AT,
            appVersion: APP_VERSION,
            importedOn: IMPORTED_ON,
            ytdlpVersion: YTDLP_VERSION,
          },
        }),
    rsgain: { data: scan, fetchedAt: FETCHED_AT, opus: true },
    app: {
      importId: IMPORT_ID,
      sourceUrl: entry?.webpage_url ?? "",
      tagSchemaVersion: 1,
      fetchedAt: FETCHED_AT,
    },
  });
}

/**
 * Track 6, "Nightvision" — the album's instrumental. LRCLIB's `instrumental` flag makes
 * `LYRICS` n/a instead of missing (§6).
 */
export function nightvision(): TrackDocument {
  const document = albumTrack(6);
  const lyricsPatch = resolveTrackDocument({
    lyrics: { data: instrumentalLyrics, fetchedAt: FETCHED_AT },
    app: {
      importId: IMPORT_ID,
      sourceUrl: playlist[5]?.webpage_url ?? "",
      tagSchemaVersion: 1,
      fetchedAt: FETCHED_AT,
    },
  });
  return {
    ...document,
    na: { ...document.na, ...lyricsPatch.na },
  };
}
