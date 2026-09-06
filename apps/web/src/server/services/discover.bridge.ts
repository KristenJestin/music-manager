/**
 * The bridge — `docs/05-recommandations.md` § La boucle qui rend ça utile.
 *
 * A recommendation is a MusicBrainz id. An import needs a YouTube URL. This module is the one
 * place that crosses the gap, and it crosses it in the two ways the specification names:
 *
 *  - **an album** → `ytmusicapi` (toolbox `POST /ytmusic/search`) finds the YouTube Music album
 *    playlist and answers an `OLAK5uy_…` id. That is the good path: an album playlist is
 *    already one release, in order, with the right track count, so the wizard's step 3 mapping
 *    is 1:1 before anybody looks at it.
 *  - **a track** → a YouTube search (`ytsearch5:`) ranked by **how close each result's duration
 *    is to the recording's length**. Duration is the only signal that survives a title full of
 *    "(Official Video)", and it is the same signal the matcher's mapping already trusts.
 *
 * Nothing here queues anything. It answers a URL and how it was found; the caller opens the
 * wizard, and the wizard is unchanged — you confirm, the algorithm merely preselected
 * (decision 002).
 *
 * **In fixtures mode the answer is `fixture://discovery`.** The search still runs, because the
 * toolbox is in fixtures mode too and its recorded answers are what make the `YT Music` badge
 * honest, but the URL handed to the importer is the offline one — otherwise `MM_FIXTURES=1`
 * would produce a wizard that cannot resolve anything.
 */
import { MMError } from "@mm/contracts";
import { serverEnv } from "#/server/env.ts";
import { toolbox, type ToolboxClient, type YtMusicCandidate } from "#/server/toolbox/client.ts";

/** The offline album every fixtures-mode import resolves against. */
export const FIXTURE_URL = "fixture://discovery";

export interface BridgeTarget {
  readonly kind: "album" | "track";
  readonly artist: string;
  /** The album title, for an album. */
  readonly album?: string;
  /** The recording title, for a track. */
  readonly title?: string;
  /** The recording's length in seconds, when known. The whole of the track ranking. */
  readonly durationSeconds?: number | null;
}

export interface SourceResolution {
  /** What to hand `createFromUrl`. */
  readonly url: string;
  /** Whether a real source was found, as opposed to falling back. Drives the `YT Music` badge. */
  readonly found: boolean;
  readonly via: "ytmusic" | "ytsearch" | "fixtures" | "none";
  /** One line for the toast: what was found, and how. */
  readonly label: string;
  /** Seconds between the recording and the chosen video, when both were known. */
  readonly durationDelta: number | null;
}

const NOT_FOUND: SourceResolution = {
  url: "",
  found: false,
  via: "none",
  label: "No YouTube source could be found for this.",
  durationDelta: null,
};

/** The best album candidate: a real album playlist, preferring the one with the most tracks. */
export function pickAlbum(candidates: readonly YtMusicCandidate[]): YtMusicCandidate | undefined {
  const albums = candidates.filter(
    (candidate) =>
      candidate.kind === "album" &&
      typeof candidate.playlist_id === "string" &&
      candidate.playlist_id !== "",
  );
  // Most tracks first: a deluxe edition is a better import than a two-track "single" that the
  // search also calls an album, and the wizard can still be pointed elsewhere.
  return [...albums].sort((a, b) => (b.track_count ?? 0) - (a.track_count ?? 0))[0];
}

/**
 * Rank videos by how close their duration is to the recording's.
 *
 * Exported and pure: `discover.test.ts` proves that a 3-second-off result wins over a
 * 40-second-off one whatever order the search returned them in, and that entries with no
 * duration at all sink rather than being treated as a perfect match.
 */
export function rankByDuration<T extends { duration?: number | null }>(
  entries: readonly T[],
  target: number | null | undefined,
): readonly { entry: T; delta: number }[] {
  const wanted = target ?? null;
  return [...entries]
    .map((entry) => ({
      entry,
      delta:
        wanted === null || entry.duration === null || entry.duration === undefined
          ? Number.POSITIVE_INFINITY
          : Math.abs(entry.duration - wanted),
    }))
    .sort((a, b) => a.delta - b.delta);
}

export interface ResolveOptions {
  readonly client?: ToolboxClient;
  readonly fixtures?: boolean;
}

/**
 * Find something importable behind one recommendation.
 *
 * It never throws on the toolbox: a container that is down means "not found", and the Console
 * says so next to the button rather than in an error boundary. The only thing that would be
 * worse than not finding a source is claiming to have found one.
 */
export async function resolveDiscoverSource(
  target: BridgeTarget,
  options: ResolveOptions = {},
): Promise<SourceResolution> {
  const fixtures = options.fixtures ?? serverEnv().MM_FIXTURES;
  const client = options.client ?? toolbox();

  const finish = (real: SourceResolution): SourceResolution =>
    fixtures
      ? {
          ...real,
          url: FIXTURE_URL,
          via: "fixtures",
          label: real.found
            ? `${real.label} — fixtures mode imports ${FIXTURE_URL}`
            : `Fixtures mode: importing ${FIXTURE_URL}`,
        }
      : real;

  try {
    if (target.kind === "album") {
      const search = await client.searchYtMusic({
        artist: target.artist,
        ...(target.album === undefined ? {} : { album: target.album }),
      });
      const album = pickAlbum(search.candidates);
      if (album === undefined) return finish(NOT_FOUND);
      const playlistId = album.playlist_id as string;
      return finish({
        url: album.url ?? `https://music.youtube.com/playlist?list=${playlistId}`,
        found: true,
        via: "ytmusic",
        label: `Found on YouTube Music: ${playlistId}${
          album.track_count === null || album.track_count === undefined
            ? ""
            : ` (${String(album.track_count)} tracks)`
        }`,
        durationDelta: null,
      });
    }

    /* A track: search, then rank on duration. */
    const query = `${target.artist} ${target.title ?? ""}`.trim();
    const extracted = await client.extract(`ytsearch5:${query}`);
    const ranked = rankByDuration(extracted.entries, target.durationSeconds);
    const best = ranked[0];
    if (best !== undefined && best.entry.webpage_url != null && best.entry.webpage_url !== "") {
      return finish({
        url: best.entry.webpage_url,
        found: true,
        via: "ytsearch",
        label: Number.isFinite(best.delta)
          ? `Closest by duration: “${best.entry.title}” (${String(Math.round(best.delta))}s off)`
          : `Best YouTube result: “${best.entry.title}”`,
        durationDelta: Number.isFinite(best.delta) ? Math.round(best.delta) : null,
      });
    }

    // Nothing usable from the search: ask YouTube Music for the song itself.
    const song = await client.searchYtMusic({
      artist: target.artist,
      ...(target.title === undefined ? {} : { title: target.title }),
    });
    const candidate = song.candidates.find(
      (one) => one.kind !== "album" && typeof one.video_id === "string" && one.video_id !== "",
    );
    if (candidate === undefined) return finish(NOT_FOUND);
    return finish({
      url: candidate.url ?? `https://music.youtube.com/watch?v=${candidate.video_id as string}`,
      found: true,
      via: "ytmusic",
      label: `Found on YouTube Music: “${candidate.title}”`,
      durationDelta: null,
    });
  } catch (error) {
    // A stopped toolbox is an answer, not a stack trace — but in fixtures mode the import can
    // still go ahead against the recorded source, which is what the e2e depends on.
    if (fixtures) {
      return {
        url: FIXTURE_URL,
        found: false,
        via: "fixtures",
        label: `Fixtures mode: importing ${FIXTURE_URL} (${MMError.from(error).message})`,
        durationDelta: null,
      };
    }
    return { ...NOT_FOUND, label: MMError.from(error).message };
  }
}
