/**
 * "Let me hear it" — a playable audio URL for something that is **not in the library**.
 *
 * Discover proposes MusicBrainz ids. MusicBrainz has no audio, so the question "what does this
 * sound like?" needs a second source, and the only free, keyless, CORS-open one is Deezer's
 * 30-second preview: a signed MP3 on a CDN that answers `access-control-allow-origin: *` and
 * honours `Range`, so the browser plays it directly with no proxy of ours in the middle.
 *
 * The join is **fuzzy, and it says so**. Everywhere else in this application a source is
 * queried by an identifier — an MBID, an ISRC — precisely so that no title matching is
 * involved. Deezer knows nothing about MusicBrainz ids, so here there is no alternative, and
 * the honest thing is to make the guess inspectable rather than to hide it: candidates are
 * scored on artist name, title and **duration against the MusicBrainz recording length**, and
 * a score under `MIN_SCORE` is answered as "no preview" rather than as the wrong song. A
 * thirty-second clip of the wrong track is worse than silence, because the reader believes it.
 *
 * Nothing here writes anything. A preview is never a source of metadata, never cached as a
 * fact about a recording, and never an import: it is a listen, and it expires (see
 * `PREVIEW_TTL_MS` in `../integrations/deezer.ts`).
 */
import { normalizeArtist, normalizeTitle, titleSimilarity } from "@mm/domain";
import {
  albumTracks,
  artistTopTracks,
  searchAlbums,
  searchArtists,
  searchTracks,
  type DeezerAlbumHit,
  type DeezerPreviewTrack,
} from "#/server/integrations/deezer.ts";
import { lookupRecording } from "#/server/integrations/musicbrainz.ts";
import { enabled, type SourceContext } from "#/server/integrations/config.ts";

/** One thing the player can play. The shape the Console's queue is made of. */
export interface PlayableTrack {
  /** Stable within a queue: `deezer:3135553`, `library:trk_01H…`. */
  readonly id: string;
  readonly title: string;
  readonly artist: string | null;
  readonly album: string | null;
  /** What goes into `audio.src`. Same-origin for the library, a CDN URL for a preview. */
  readonly src: string;
  readonly source: "deezer" | "library";
  /**
   * The Discover subject this came from, when it came from one.
   *
   * Carried so the player can re-resolve its own queue without knowing anything about the page
   * that filled it: a Deezer `src` is a signed ticket that goes stale, and "ask for this
   * subject again, skipping the cache" is the only repair available. Null for anything the
   * player was handed directly, such as a library track picked off an album page.
   */
  readonly subject: string | null;
  readonly coverUrl: string | null;
  /** Seconds. The *full* track length for a preview, which is why the bar says "30 s". */
  readonly durationSeconds: number | null;
}

/** What a `discover_items.subject` means, parsed once. */
export interface Subject {
  readonly kind: "recording" | "release-group" | "artist";
  readonly mbid: string;
}

export function parseSubject(subject: string): Subject | null {
  const at = subject.indexOf(":");
  if (at <= 0) return null;
  const kind = subject.slice(0, at);
  const mbid = subject.slice(at + 1).trim();
  if (mbid === "") return null;
  if (kind !== "recording" && kind !== "release-group" && kind !== "artist") return null;
  return { kind, mbid };
}

/** What the resolver is asked about: a `discover_items` row, reduced to what it needs. */
export interface PreviewRequest {
  readonly subject: string;
  readonly title: string;
  readonly artist: string;
  readonly albumTitle?: string | null;
}

/**
 * Below this, the best candidate is not believed and the answer is "no preview".
 *
 * Deliberately on the permissive side of strict: it keeps "Get Lucky" matching "Get Lucky
 * (Radio Edit)" — the same recording in different packaging, which the duration term then
 * separates — while refusing the hits that share only a word or two with what was asked for.
 */
const MIN_SCORE = 0.62;

/**
 * The preview queue for one Discover subject, or `null` when there is nothing to play.
 *
 * `null` is a normal answer and the Console renders it as a disabled button, never as an
 * error: Deezer's catalogue is not MusicBrainz's, and a release-group nobody licensed to them
 * simply has no clip. The three subject kinds ask three different questions, which is the
 * shape `docs/05-recommandations.md` already gives them.
 */
export async function resolvePreview(
  ctx: SourceContext,
  request: PreviewRequest,
): Promise<readonly PlayableTrack[] | null> {
  if (!enabled(ctx, "deezer")) return null;
  const subject = parseSubject(request.subject);
  if (subject === null) return null;

  const tracks = await resolveTracks(ctx, subject, request);
  if (tracks === null) return null;
  // Stamped here, once, rather than threaded through three resolvers that have no use for it:
  // it is the caller's question, not a property of the Deezer record.
  return tracks.map((track) => ({ ...track, subject: request.subject }));
}

async function resolveTracks(
  ctx: SourceContext,
  subject: Subject,
  request: PreviewRequest,
): Promise<readonly PlayableTrack[] | null> {
  if (subject.kind === "recording") {
    const track = await previewForRecording(ctx, subject.mbid, request);
    return track === null ? null : [track];
  }
  if (subject.kind === "release-group") return await previewForAlbum(ctx, request);
  return await previewForArtist(ctx, request);
}

/* ------------------------------------------------------------------ */
/* a recording: the candidate whose duration is closest                */
/* ------------------------------------------------------------------ */

async function previewForRecording(
  ctx: SourceContext,
  mbid: string,
  request: PreviewRequest,
): Promise<PlayableTrack | null> {
  const wanted = await recordingSeconds(ctx, mbid);
  const hits = await searchTracks(ctx, `${request.artist} ${request.title}`, 10);
  const best = bestTrackMatch(hits.data ?? [], {
    artist: request.artist,
    title: request.title,
    durationSeconds: wanted,
  });
  return best === null ? null : playable(best);
}

/**
 * The MusicBrainz length of a recording, in seconds, or `null`.
 *
 * Read through the ordinary cached client with the ordinary preset, so the row this needs is
 * usually one an import already wrote — and a MusicBrainz outage costs a worse guess rather
 * than a failed click.
 */
async function recordingSeconds(ctx: SourceContext, mbid: string): Promise<number | null> {
  if (!enabled(ctx, "musicbrainz")) return null;
  try {
    const answer = await lookupRecording(ctx, mbid);
    const ms = answer.data?.length;
    return typeof ms === "number" && ms > 0 ? Math.round(ms / 1000) : null;
  } catch {
    return null;
  }
}

export interface MatchTarget {
  readonly artist: string;
  readonly title: string;
  readonly durationSeconds: number | null;
}

/**
 * Score a Deezer hit against what was asked for: title, artist, and duration.
 *
 * Duration is the discriminator whenever MusicBrainz gave one — it is what separates the album
 * cut from the radio edit, two records whose titles are nearly identical — so it carries the
 * largest single weight, and it is simply absent from the sum when MusicBrainz has no length
 * rather than counted as a zero.
 */
export function scoreCandidate(track: DeezerPreviewTrack, target: MatchTarget): number {
  const title = titleSimilarity(
    normalizeTitle(track.title ?? track.title_short ?? ""),
    normalizeTitle(target.title),
  );
  const artist = titleSimilarity(
    normalizeArtist(track.artist?.name ?? ""),
    normalizeArtist(target.artist),
  );
  const wanted = target.durationSeconds;
  const got = track.duration;
  if (wanted === null || got === undefined || got <= 0) return title * 0.6 + artist * 0.4;
  // Ten seconds out is still the same recording; a minute out is not. Linear in between.
  const closeness = Math.max(0, 1 - Math.abs(got - wanted) / 60);
  return title * 0.4 + artist * 0.25 + closeness * 0.35;
}

/** The best-scoring playable candidate, or `null` when none of them is convincing. */
export function bestTrackMatch(
  tracks: readonly DeezerPreviewTrack[],
  target: MatchTarget,
): DeezerPreviewTrack | null {
  let best: DeezerPreviewTrack | null = null;
  let bestScore = MIN_SCORE;
  for (const track of tracks) {
    if (!hasPreview(track)) continue;
    const score = scoreCandidate(track, target);
    if (score >= bestScore) {
      best = track;
      bestScore = score;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* a release-group: the album's tracklist, in order                    */
/* ------------------------------------------------------------------ */

async function previewForAlbum(
  ctx: SourceContext,
  request: PreviewRequest,
): Promise<readonly PlayableTrack[] | null> {
  const name = request.albumTitle ?? request.title;
  const albums = await searchAlbums(ctx, `${request.artist} ${name}`, 5);
  const album = bestAlbumMatch(albums.data ?? [], { artist: request.artist, title: name });
  if (album?.id === undefined) return null;

  const tracks = await albumTracks(ctx, album.id);
  const playables = (tracks.data ?? [])
    .filter(hasPreview)
    .map((track) => playable(track, album.title ?? name, album.cover_medium ?? null));
  return playables.length === 0 ? null : playables;
}

export function bestAlbumMatch(
  albums: readonly DeezerAlbumHit[],
  target: { artist: string; title: string },
): DeezerAlbumHit | null {
  let best: DeezerAlbumHit | null = null;
  let bestScore = MIN_SCORE;
  for (const album of albums) {
    const score =
      titleSimilarity(normalizeTitle(album.title ?? ""), normalizeTitle(target.title)) * 0.6 +
      titleSimilarity(normalizeArtist(album.artist?.name ?? ""), normalizeArtist(target.artist)) *
        0.4;
    if (score >= bestScore) {
      best = album;
      bestScore = score;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* an artist: what they are known for                                  */
/* ------------------------------------------------------------------ */

async function previewForArtist(
  ctx: SourceContext,
  request: PreviewRequest,
): Promise<readonly PlayableTrack[] | null> {
  const name = request.artist === "" ? request.title : request.artist;
  const artists = await searchArtists(ctx, name, 5);
  const match = (artists.data ?? []).find(
    (candidate) =>
      candidate.id !== undefined &&
      titleSimilarity(normalizeArtist(candidate.name ?? ""), normalizeArtist(name)) >= MIN_SCORE,
  );
  if (match?.id === undefined) return null;

  const top = await artistTopTracks(ctx, match.id, 10);
  const playables = (top.data ?? []).filter(hasPreview).map((track) => playable(track));
  return playables.length === 0 ? null : playables;
}

/* ------------------------------------------------------------------ */
/* shared                                                              */
/* ------------------------------------------------------------------ */

function hasPreview(track: DeezerPreviewTrack): boolean {
  return typeof track.preview === "string" && track.preview !== "";
}

function playable(
  track: DeezerPreviewTrack,
  albumTitle: string | null = null,
  cover: string | null = null,
): PlayableTrack {
  return {
    id: `deezer:${String(track.id ?? track.preview ?? "")}`,
    title: track.title ?? track.title_short ?? "Untitled",
    artist: track.artist?.name ?? null,
    album: track.album?.title ?? albumTitle,
    src: track.preview ?? "",
    source: "deezer",
    subject: null,
    coverUrl: track.album?.cover_medium ?? cover,
    durationSeconds:
      typeof track.duration === "number" && track.duration > 0 ? track.duration : null,
  };
}
