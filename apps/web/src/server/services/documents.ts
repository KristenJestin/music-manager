/**
 * The metadata document, built from the real sources — layer 2 of `docs/03-metadonnees.md` §1.
 *
 * `build()` is the only place in the application that decides *which* source answers *which*
 * question for a track. Everything it fetches goes through the raw cache first, so the same
 * function with `offline: true` is `rebuild()`: identical code, identical output, zero
 * outgoing requests. That equality is the whole point of the phase — it is what makes §8's
 * background re-tag possible, and it is asserted by a request counter rather than trusted.
 *
 * The order of operations is not arbitrary:
 *
 *  1. **MusicBrainz first**, because everything else is keyed by what it says. The release
 *     gives the album block and the track's position; the recording gives the ISRCs that
 *     Deezer is queried by, the work that carries the composer, and the genres that decide
 *     whether Last.fm is consulted at all.
 *  2. **The keyed sources next** — Deezer by ISRC, AcoustID by fingerprint, ListenBrainz by
 *     recording MBID. None of them involves fuzzy matching, so none of them can be wrong
 *     about *which* track it is answering for.
 *  3. **The fuzzy ones last**, and only LRCLIB is fuzzy: artist, title, album and duration.
 *     Its answer is chosen by `chooseLrclibEntry`, in the domain, where it can be tested.
 *
 * Precedence and locks are not applied here either: `merge` in `@mm/domain` owns both, and
 * this module's job is to hand it patches in the right order with a locked set on top.
 */
import { and, eq, isNull, or } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import {
  resolveTrackDocument,
  TAG_SCHEMA_VERSION,
  trackCompleteness,
  type CaaIndex,
  type DocumentPatch,
  type Field,
  type LastfmTagInput,
  type ListenBrainzTagInput,
  type MbArtistLike,
  type MbRecording,
  type MbRelease,
  type MbTrack,
  type MbWork,
  type TrackDocument,
  type YtdlpEntry,
} from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  artistsCache,
  importTracks,
  imports,
  libraryTracks,
  metadataDocuments,
  type Import,
  type ImportTrack,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import type { ToolboxClient } from "#/server/toolbox/client.ts";
import { get as cacheGet } from "#/server/services/cache.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import { APP_VERSION } from "#/server/version.ts";
import * as acoustid from "#/server/integrations/acoustid.ts";
import * as caa from "#/server/integrations/coverartarchive.ts";
import * as deezer from "#/server/integrations/deezer.ts";
import * as lastfm from "#/server/integrations/lastfm.ts";
import * as listenbrainz from "#/server/integrations/listenbrainz.ts";
import * as lrclib from "#/server/integrations/lrclib.ts";
import * as musicbrainz from "#/server/integrations/musicbrainz.ts";
import * as wikimedia from "#/server/integrations/wikimedia.ts";
import {
  sourcesConfig,
  type SourceContext,
  type SourcesConfig,
} from "#/server/integrations/config.ts";
import { countingRequests } from "#/server/integrations/http.ts";

/* ------------------------------------------------------------------ */
/* what a build reports about itself                                   */
/* ------------------------------------------------------------------ */

/** One source consulted, and what came of it. `mm doc build` prints this list. */
export interface SourceVisit {
  readonly source: string;
  readonly key: string;
  readonly outcome: "hit" | "fetched" | "absent" | "skipped" | "failed";
  readonly fetchedAt?: string;
  readonly note?: string;
}

export interface BuildResult {
  readonly importTrackId: string;
  readonly document: TrackDocument;
  readonly completeness: number | null;
  readonly documentId: string;
  /** Outgoing HTTP requests this build caused. `rebuild --offline` asserts it is zero. */
  readonly requests: number;
  readonly visits: readonly SourceVisit[];
}

export interface BuildOptions {
  readonly db?: Database;
  readonly toolbox?: ToolboxClient;
  readonly settings?: Settings;
  /** No request may leave the process; a cache miss is an error. */
  readonly offline?: boolean;
  /** Refetch even when the cached answer is younger than its TTL. */
  readonly refresh?: boolean;
  readonly signal?: AbortSignal;
  /** Frozen clock, for the golden files and the tests. */
  readonly now?: Date;
  /** Do not write `metadata_documents`; used by the CLI's dry runs. */
  readonly persist?: boolean;
  readonly env?: Record<string, string | undefined>;
}

/* ------------------------------------------------------------------ */
/* finding the track                                                   */
/* ------------------------------------------------------------------ */

export interface TrackRef {
  readonly track: ImportTrack;
  readonly job: Import;
}

/**
 * Accept either kind of id.
 *
 * A library track is a *placed* import track, and `library_tracks.import_track_id` keeps the
 * link precisely so a re-tag can rebuild the document from the same inputs that produced the
 * file (§8). A library track with no import behind it — a scanned-in file, which arrives in
 * P07 — cannot be rebuilt yet, and says so instead of guessing.
 */
export async function resolveTrack(id: string, db: Database = defaultDb()): Promise<TrackRef> {
  let importTrackId = id;

  if (id.startsWith("ltr_")) {
    const [row] = await db.select().from(libraryTracks).where(eq(libraryTracks.id, id)).limit(1);
    if (row === undefined) throw new MMError("NOT_FOUND", `No library track with id ${id}.`);
    if (row.importTrackId === null) {
      throw new MMError(
        "NOT_FOUND",
        `Library track ${id} was not produced by an import, so it has no sources to rebuild from.`,
        { hint: "Scanned-in files get their documents in P07.", action: "Import it instead" },
      );
    }
    importTrackId = row.importTrackId;
  }

  const [track] = await db
    .select()
    .from(importTracks)
    .where(eq(importTracks.id, importTrackId))
    .limit(1);
  if (track === undefined) {
    throw new MMError("NOT_FOUND", `No import track with id ${importTrackId}.`, {
      hint: "`mm job <import id>` lists an import's tracks.",
    });
  }

  const [job] = await db.select().from(imports).where(eq(imports.id, track.importId)).limit(1);
  if (job === undefined) throw new MMError("NOT_FOUND", `No import with id ${track.importId}.`);

  return { track, job };
}

/** Every mapped track of an import, in tracklist order — what `tag` rebuilds in one go. */
export async function trackIdsOfImport(
  importId: string,
  db: Database = defaultDb(),
): Promise<string[]> {
  const rows = await db
    .select({ id: importTracks.id })
    .from(importTracks)
    .where(and(eq(importTracks.importId, importId), eq(importTracks.role, "mapped")));
  return rows.map((row) => row.id);
}

/* ------------------------------------------------------------------ */
/* the build                                                           */
/* ------------------------------------------------------------------ */

/** The measured loudness a `tag` run stored for this track, if any (see ./jobs/steps/tag.ts). */
export const RSGAIN_SOURCE = "rsgain";

export function rsgainKey(importTrackId: string): string {
  return `track/${importTrackId}`;
}

interface Collected {
  readonly visits: SourceVisit[];
  readonly ctx: SourceContext;
}

function note(collected: Collected, visit: SourceVisit): void {
  collected.visits.push(visit);
}

/**
 * Run one source lookup and refuse to let it sink the document.
 *
 * Two failures are expected rather than exceptional, and they mean the same thing to the
 * result: a source that is down (§4's acceptance case — "Deezer unavailable, the document is
 * still valid") and a source that was never fetched while offline. Both leave the fields that
 * source owns *missing*, which is exactly what "missing" means. Only the MusicBrainz release
 * is exempt: without it there is no album, no track and no question worth asking anyone else.
 */
async function optional<T>(
  collected: Collected,
  visit: Omit<SourceVisit, "outcome">,
  run: () => Promise<T>,
): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    const failure = MMError.from(error);
    note(collected, {
      ...visit,
      outcome: failure.code === "OFFLINE_CACHE_MISS" ? "skipped" : "failed",
      note: failure.code === "OFFLINE_CACHE_MISS" ? "not in the cache, offline" : failure.message,
    });
    return null;
  }
}

/** The MusicBrainz track row of a release, by medium and position. */
function trackOf(
  release: MbRelease | null,
  mediumPosition: number | null,
  trackPosition: number | null,
): MbTrack | undefined {
  const media = release?.media ?? [];
  const medium =
    mediumPosition === null
      ? media[0]
      : (media.find((candidate) => candidate.position === mediumPosition) ?? media[0]);
  if (trackPosition === null) return undefined;
  return (medium?.tracks ?? []).find((candidate) => candidate.position === trackPosition);
}

/** Every artist MBID credited on the release and on the track, release first, deduplicated. */
function creditedArtistIds(release: MbRelease | null, track: MbTrack | undefined): string[] {
  const out: string[] = [];
  const add = (credits: readonly { readonly artist?: { readonly id?: string } }[] | undefined) => {
    for (const credit of credits ?? []) {
      const id = credit.artist?.id;
      if (id !== undefined && id !== "" && !out.includes(id)) out.push(id);
    }
  };
  add(release?.["artist-credit"]);
  add(track?.["artist-credit"]);
  add(track?.recording?.["artist-credit"]);
  return out;
}

/** The work a recording performs, taken from the embedded relations when they are there. */
function embeddedWork(recording: MbRecording | null): MbWork | undefined {
  for (const relation of recording?.relations ?? []) {
    if (relation["target-type"] === "work" && relation.work !== undefined) return relation.work;
  }
  return undefined;
}

/** The best thumbnail yt-dlp reported — the §4 fallback when the archive has no cover. */
export function youtubeThumbnail(entry: YtdlpEntry): string | null {
  const raw = entry as YtdlpEntry & {
    thumbnail?: string;
    thumbnails?: readonly { url?: string; width?: number; preference?: number }[];
  };
  if (typeof raw.thumbnail === "string" && raw.thumbnail !== "") return raw.thumbnail;
  const ranked = [...(raw.thumbnails ?? [])].sort(
    (a, b) => (b.width ?? b.preference ?? 0) - (a.width ?? a.preference ?? 0),
  );
  const best = ranked[0]?.url;
  return typeof best === "string" && best !== "" ? best : null;
}

/**
 * The cover fallback of §4, as a patch.
 *
 * It carries the `youtube` source because that is where the image comes from, and `youtube`
 * is last in `SOURCE_PRECEDENCE` — so the day the Cover Art Archive gets a front for this
 * release, a rebuild replaces the thumbnail without anyone deciding anything.
 */
export function thumbnailCoverPatch(url: string, fetchedAt: string): DocumentPatch {
  return {
    fields: {
      front_cover: {
        value: [
          {
            kind: "front" as const,
            mimeType: "image/jpeg",
            url,
            comment: "YouTube thumbnail, cropped square",
          },
        ],
        source: "youtube" as const,
        confidence: 0.5,
        fetchedAt,
        locked: false,
      },
    },
  };
}

/** The locked fields of the document already stored for this track, if there is one. */
async function lockedFields(
  db: Database,
  importTrackId: string,
): Promise<Record<string, Field> | undefined> {
  const [row] = await db
    .select()
    .from(metadataDocuments)
    .where(eq(metadataDocuments.importTrackId, importTrackId))
    .limit(1);
  if (row === undefined) return undefined;
  const held = row.document as unknown as TrackDocument;
  const locked: Record<string, Field> = {};
  for (const [name, value] of Object.entries(held.fields ?? {})) {
    if (value.locked) locked[name] = value;
  }
  return Object.keys(locked).length === 0 ? undefined : locked;
}

/**
 * Build (or rebuild) one track's document.
 *
 * Every `await` below is a source; every one of them goes through `cached()`, so the second
 * run of this function over the same track makes no request at all whether or not `offline`
 * was passed. `offline` only changes what happens on a **miss**: an error instead of a call.
 */
export async function build(id: string, options: BuildOptions = {}): Promise<BuildResult> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const config = sourcesConfig(settings, options.env ?? process.env);
  const { track, job } = await resolveTrack(id, db);

  const ctx: SourceContext = {
    db,
    config,
    offline: options.offline ?? false,
    refresh: options.refresh ?? false,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };
  const collected: Collected = { visits: [], ctx };
  const now = options.now ?? new Date();
  const nowIso = now.toISOString();

  const { result, requests } = await countingRequests(async () =>
    assemble(collected, { track, job, config, now: nowIso, toolbox: options.toolbox }),
  );

  const document = result;
  const score = trackCompleteness(document).score;

  let documentId = "";
  if (options.persist !== false) {
    documentId = await persist(db, track, document, score);
  }

  return {
    importTrackId: track.id,
    document,
    completeness: score,
    documentId,
    requests,
    visits: collected.visits,
  };
}

/** `build` with the network unplugged. This is what the background re-tag of §8 calls. */
export async function rebuild(id: string, options: BuildOptions = {}): Promise<BuildResult> {
  return await build(id, { ...options, offline: options.offline ?? true });
}

interface AssembleInput {
  readonly track: ImportTrack;
  readonly job: Import;
  readonly config: SourcesConfig;
  readonly now: string;
  readonly toolbox?: ToolboxClient;
}

async function assemble(collected: Collected, input: AssembleInput): Promise<TrackDocument> {
  const { ctx } = collected;
  const { track, job, config } = input;
  const enabled = config.enabled;

  /* ---- 1 · MusicBrainz: the release, then the recording ---- */
  const releaseMbid = job.releaseMbid;
  let release: MbRelease | null = null;
  let releaseFetchedAt = input.now;

  if (releaseMbid !== null && releaseMbid !== "" && enabled.musicbrainz) {
    const answer = await musicbrainz.lookupRelease(ctx, releaseMbid);
    release = answer.data;
    releaseFetchedAt = answer.fetchedAt;
    note(collected, {
      source: "musicbrainz",
      key: `release/${releaseMbid}`,
      outcome: answer.data === null ? "absent" : answer.fresh ? "fetched" : "hit",
      fetchedAt: answer.fetchedAt,
    });
  } else {
    note(collected, {
      source: "musicbrainz",
      key: "release",
      outcome: "skipped",
      note: releaseMbid === null ? "the import has no chosen release" : "source disabled",
    });
  }

  const mbTrack = trackOf(release, track.mediumPosition, track.trackPosition);

  let recording: MbRecording | null = mbTrack?.recording ?? null;
  let recordingFetchedAt = releaseFetchedAt;
  const recordingMbid = track.recordingMbid ?? recording?.id ?? null;

  if (recordingMbid !== null && recordingMbid !== "" && enabled.musicbrainz) {
    // The recording embedded in a release lookup has no ISRC, no genre and no work relation:
    // `inc=recordings` is a tracklist, not a set of recordings. The standalone lookup is what
    // brings the half of the document MusicBrainz alone can fill. When it cannot be made —
    // offline, never cached — the embedded one still carries the title and the credits.
    const answer = await optional(
      collected,
      { source: "musicbrainz", key: `recording/${recordingMbid}` },
      async () => await musicbrainz.lookupRecording(ctx, recordingMbid),
    );
    if (answer !== null) {
      if (answer.data !== null) {
        recording = answer.data;
        recordingFetchedAt = answer.fetchedAt;
      }
      note(collected, {
        source: "musicbrainz",
        key: `recording/${recordingMbid}`,
        outcome: answer.data === null ? "absent" : answer.fresh ? "fetched" : "hit",
        fetchedAt: answer.fetchedAt,
      });
    }
  }

  /* ---- the work: embedded when the recording carried its relations ---- */
  let work: MbWork | undefined = embeddedWork(recording);
  let workFetchedAt = recordingFetchedAt;
  if (work !== undefined && (work.relations ?? []).length === 0 && enabled.musicbrainz) {
    const workMbid = work.id;
    if (workMbid !== undefined && workMbid !== "") {
      const answer = await optional(
        collected,
        { source: "musicbrainz", key: `work/${workMbid}` },
        async () => await musicbrainz.lookupWork(ctx, workMbid),
      );
      if (answer !== null) {
        if (answer.data !== null) {
          work = answer.data;
          workFetchedAt = answer.fetchedAt;
        }
        note(collected, {
          source: "musicbrainz",
          key: `work/${workMbid}`,
          outcome: answer.data === null ? "absent" : answer.fresh ? "fetched" : "hit",
          fetchedAt: answer.fetchedAt,
        });
      }
    }
  }

  /* ---- the artists: WEBSITE, and the artist.jpg of §3 ---- */
  const artists: { data: MbArtistLike; fetchedAt: string }[] = [];
  if (enabled.musicbrainz) {
    for (const artistMbid of creditedArtistIds(release, mbTrack)) {
      const answer = await optional(
        collected,
        { source: "musicbrainz", key: `artist/${artistMbid}` },
        async () => await musicbrainz.lookupArtist(ctx, artistMbid),
      );
      if (answer === null) continue;
      note(collected, {
        source: "musicbrainz",
        key: `artist/${artistMbid}`,
        outcome: answer.data === null ? "absent" : answer.fresh ? "fetched" : "hit",
        fetchedAt: answer.fetchedAt,
      });
      if (answer.data === null) continue;
      const artist = answer.data as MbArtistLike;
      artists.push({ data: artist, fetchedAt: answer.fetchedAt });
      await rememberArtist(collected, artist, answer.fetchedAt);
    }
  }

  /* ---- 2 · the keyed sources ---- */
  const isrcs = recording?.isrcs ?? [];
  let deezerTrack: { data: unknown; fetchedAt: string } | null = null;
  if (enabled.deezer && isrcs.length > 0) {
    try {
      const found = await deezer.firstKnownIsrc(ctx, isrcs);
      note(collected, {
        source: "deezer",
        key: `track/isrc:${found?.isrc ?? isrcs[0] ?? ""}`,
        outcome: found === null ? "absent" : found.fresh ? "fetched" : "hit",
        ...(found === null ? {} : { fetchedAt: found.fetchedAt }),
      });
      if (found !== null) deezerTrack = { data: found.track, fetchedAt: found.fetchedAt };
    } catch (error) {
      // §4 and the acceptance criteria: Deezer down costs BPM and ITUNESADVISORY, nothing
      // else. A source that fails is a missing field, never a failed document.
      note(collected, {
        source: "deezer",
        key: `track/isrc:${isrcs[0] ?? ""}`,
        outcome: "failed",
        note: MMError.from(error).message,
      });
    }
  }

  let acoustIdAnswer: { data: unknown; fetchedAt: string } | null = null;
  if (enabled.acoustid && track.fingerprint !== null && track.fingerprint !== "") {
    try {
      const answer = await acoustid.lookup(
        ctx,
        track.fingerprint,
        track.fingerprintDuration ?? track.sourceDuration ?? 0,
      );
      note(collected, {
        source: "acoustid",
        key: acoustid.fingerprintKey(
          track.fingerprint,
          track.fingerprintDuration ?? track.sourceDuration ?? 0,
        ),
        outcome:
          answer === null
            ? "skipped"
            : answer.data === null
              ? "absent"
              : answer.fresh
                ? "fetched"
                : "hit",
        ...(answer === null ? { note: "no AcoustID key configured" } : {}),
        ...(answer === null ? {} : { fetchedAt: answer.fetchedAt }),
      });
      // Asked and told "nothing": that is an answer. Passing an empty response lets the
      // resolver mark ACOUSTID_ID **n/a** — the source says it has no id for this audio —
      // instead of leaving it missing for ever, which §6 counts very differently.
      if (answer !== null) {
        acoustIdAnswer = {
          data: answer.data ?? { status: "ok", results: [] },
          fetchedAt: answer.fetchedAt,
        };
      }
    } catch (error) {
      note(collected, {
        source: "acoustid",
        key: "lookup",
        outcome: "failed",
        note: MMError.from(error).message,
      });
    }
  }

  /* ---- 3 · the genre chain: MusicBrainz, then Last.fm, then ListenBrainz ---- */
  const artistName = joinedArtist(release, mbTrack, recording) ?? track.uploader ?? "";
  const trackTitle = mbTrack?.title ?? recording?.title ?? track.trackTitle ?? track.sourceTitle;

  let lastfmTags: { data: readonly LastfmTagInput[]; fetchedAt: string } | undefined;
  if (enabled.lastfm && artistName !== "") {
    try {
      const answer = await lastfm.trackTopTags(ctx, artistName, trackTitle);
      const tags = lastfm.tagList(answer?.data ?? null);
      const fallback = tags.length > 0 ? null : await lastfm.artistTopTags(ctx, artistName);
      const chosen = tags.length > 0 ? tags : lastfm.tagList(fallback?.data ?? null);
      const fetchedAt = (tags.length > 0 ? answer?.fetchedAt : fallback?.fetchedAt) ?? input.now;
      note(collected, {
        source: "lastfm",
        key: tags.length > 0 ? `track.getTopTags/${trackTitle}` : `artist.getTopTags/${artistName}`,
        outcome:
          answer === null
            ? "skipped"
            : chosen.length === 0
              ? "absent"
              : (tags.length > 0 ? answer.fresh : (fallback?.fresh ?? false))
                ? "fetched"
                : "hit",
        ...(answer === null ? { note: "no Last.fm key configured" } : {}),
        fetchedAt,
      });
      if (chosen.length > 0) lastfmTags = { data: chosen, fetchedAt };
    } catch (error) {
      note(collected, {
        source: "lastfm",
        key: "toptags",
        outcome: "failed",
        note: MMError.from(error).message,
      });
    }
  }

  let lbTags: { data: readonly ListenBrainzTagInput[]; fetchedAt: string } | undefined;
  if (enabled.listenbrainz && recordingMbid !== null && recordingMbid !== "") {
    try {
      const answer = await listenbrainz.recordingTags(ctx, recordingMbid);
      const entry = answer.data?.[recordingMbid];
      const tags = [...(entry?.tag?.recording ?? []), ...(entry?.tag?.artist ?? [])];
      note(collected, {
        source: "listenbrainz",
        key: `metadata/recording/${recordingMbid}`,
        outcome: tags.length === 0 ? "absent" : answer.fresh ? "fetched" : "hit",
        fetchedAt: answer.fetchedAt,
      });
      if (tags.length > 0) lbTags = { data: tags, fetchedAt: answer.fetchedAt };
    } catch (error) {
      note(collected, {
        source: "listenbrainz",
        key: "metadata/recording",
        outcome: "failed",
        note: MMError.from(error).message,
      });
    }
  }

  /* ---- 4 · the cover, and the YouTube fallback ---- */
  let coverIndex: CaaIndex | null = null;
  let coverFetchedAt = input.now;
  if (enabled.coverartarchive && releaseMbid !== null && releaseMbid !== "") {
    try {
      const answer = await caa.index(ctx, releaseMbid);
      coverIndex = answer.data;
      coverFetchedAt = answer.fetchedAt;
      note(collected, {
        source: "coverartarchive",
        key: `release/${releaseMbid}`,
        outcome: answer.data === null ? "absent" : answer.fresh ? "fetched" : "hit",
        fetchedAt: answer.fetchedAt,
      });
      if (caa.frontUrl(coverIndex) === null && job.releaseGroupMbid !== null) {
        const group = await caa.releaseGroupIndex(ctx, job.releaseGroupMbid);
        if (caa.frontUrl(group.data) !== null) {
          coverIndex = group.data;
          coverFetchedAt = group.fetchedAt;
        }
        note(collected, {
          source: "coverartarchive",
          key: `release-group/${job.releaseGroupMbid}`,
          outcome: group.data === null ? "absent" : group.fresh ? "fetched" : "hit",
          fetchedAt: group.fetchedAt,
        });
      }
    } catch (error) {
      note(collected, {
        source: "coverartarchive",
        key: `release/${releaseMbid}`,
        outcome: "failed",
        note: MMError.from(error).message,
      });
    }
  }

  const entry = track.raw as YtdlpEntry;
  /** When this track was observed — the instant `resolve` wrote its yt-dlp payload down. */
  const observedAt = track.createdAt.toISOString();
  const extra: DocumentPatch[] = [];
  if (caa.frontUrl(coverIndex) === null && config.coverOrder.includes("youtube")) {
    const thumbnail = youtubeThumbnail(entry);
    if (thumbnail !== null) {
      extra.push(thumbnailCoverPatch(thumbnail, input.now));
      note(collected, { source: "youtube", key: "thumbnail", outcome: "hit" });
    }
  }

  /* ---- 5 · the lyrics: the only fuzzy question we ask ---- */
  let lyrics: { data: unknown; fetchedAt: string } | undefined;
  if (enabled.lrclib && artistName !== "" && trackTitle !== "") {
    try {
      const chosen = await lrclib.lyricsFor(ctx, {
        artist: artistName,
        track: trackTitle,
        ...(release?.title === undefined ? {} : { album: release.title }),
        ...(durationOf(mbTrack, recording, track) === null
          ? {}
          : { durationSeconds: durationOf(mbTrack, recording, track) as number }),
      });
      note(collected, {
        source: "lrclib",
        key: `${chosen.via}/${artistName} — ${trackTitle}`,
        outcome: chosen.entry === null ? "absent" : chosen.fresh ? "fetched" : "hit",
        fetchedAt: chosen.fetchedAt,
      });
      // A `null` entry is still passed to the resolver: it is how "LRCLIB has nothing yet"
      // stays *missing* rather than becoming n/a (see fromLrclib).
      lyrics = { data: chosen.entry, fetchedAt: chosen.fetchedAt };
    } catch (error) {
      note(collected, {
        source: "lrclib",
        key: "search",
        outcome: "failed",
        note: MMError.from(error).message,
      });
    }
  }

  /* ---- 6 · the loudness a previous `tag` measured on our own file ---- */
  const rsgainRow = await cacheGet<Record<string, unknown>>(
    RSGAIN_SOURCE,
    rsgainKey(track.id),
    ctx.db,
  );
  if (rsgainRow !== null) {
    note(collected, {
      source: "rsgain",
      key: rsgainKey(track.id),
      outcome: "hit",
      fetchedAt: rsgainRow.fetchedAt,
    });
  }

  const locked = await lockedFields(ctx.db, track.id);

  return resolveTrackDocument({
    ...(release === null
      ? {}
      : {
          release: {
            data: release,
            fetchedAt: releaseFetchedAt,
            trackPosition: track.trackPosition ?? 1,
            ...(track.mediumPosition === null ? {} : { mediumPosition: track.mediumPosition }),
          },
        }),
    ...(recording === null
      ? {}
      : { recording: { data: recording, fetchedAt: recordingFetchedAt } }),
    ...(work === undefined ? {} : { work: { data: work, fetchedAt: workFetchedAt } }),
    ...(artists.length === 0 ? {} : { artists }),
    ...(coverIndex === null ? {} : { coverArt: { data: coverIndex, fetchedAt: coverFetchedAt } }),
    ...(lyrics === undefined
      ? {}
      : { lyrics: { data: lyrics.data as never, fetchedAt: lyrics.fetchedAt } }),
    ...(deezerTrack === null
      ? {}
      : { deezer: { data: deezerTrack.data as never, fetchedAt: deezerTrack.fetchedAt } }),
    ...(acoustIdAnswer === null
      ? {}
      : {
          acoustId: {
            data: acoustIdAnswer.data as never,
            fetchedAt: acoustIdAnswer.fetchedAt,
            // §2.5: the raw Chromaprint is bulky, so it is written only on request.
            ...(config.writeAcoustidFingerprint && track.fingerprint !== null
              ? { fingerprint: track.fingerprint }
              : {}),
          },
        }),
    ...(lastfmTags === undefined ? {} : { lastfm: lastfmTags }),
    ...(lbTags === undefined ? {} : { listenbrainz: lbTags }),
    tagOptions: { maxGenres: config.maxGenres, minCount: config.genreMinCount },
    ...(rsgainRow === null
      ? {}
      : {
          rsgain: {
            data: rsgainRow.data as never,
            fetchedAt: rsgainRow.fetchedAt,
            opus: (track.libraryPath ?? track.downloadPath ?? "").toLowerCase().endsWith(".opus"),
          },
        }),
    // The yt-dlp entry was fetched by `resolve`, not now: stamping it with the clock would
    // make two rebuilds of one unchanged track produce two different documents, and §8 rests
    // on them producing the same one. `created_at` is when the row — and the payload in it —
    // came into being.
    youtube: {
      data: entry,
      fetchedAt: observedAt,
      appVersion: APP_VERSION,
      importedOn: observedAt.slice(0, 10),
    },
    ...(extra.length === 0 ? {} : { extra }),
    app: {
      importId: job.id,
      sourceUrl: track.url,
      tagSchemaVersion: TAG_SCHEMA_VERSION,
      fetchedAt: observedAt,
    },
    ...(locked === undefined ? {} : { locked }),
  });
}

/** `ARTIST` as the sources credit it, for the LRCLIB and Last.fm queries. */
function joinedArtist(
  release: MbRelease | null,
  mbTrack: MbTrack | undefined,
  recording: MbRecording | null,
): string | null {
  const credit =
    mbTrack?.["artist-credit"] ??
    recording?.["artist-credit"] ??
    mbTrack?.recording?.["artist-credit"] ??
    release?.["artist-credit"];
  if (credit === undefined || credit.length === 0) return null;
  const joined = credit.map((entry) => entry.name ?? entry.artist?.name ?? "").join(" & ");
  return joined === "" ? null : joined;
}

/** Seconds, from the most authoritative source that has a length. */
function durationOf(
  mbTrack: MbTrack | undefined,
  recording: MbRecording | null,
  track: ImportTrack,
): number | null {
  const millis = mbTrack?.length ?? recording?.length;
  if (typeof millis === "number" && millis > 0) return Math.round(millis / 1000);
  if (track.sourceDuration !== null) return Math.round(track.sourceDuration);
  return null;
}

/* ------------------------------------------------------------------ */
/* artists_cache                                                       */
/* ------------------------------------------------------------------ */

/**
 * Keep the artist, and the image `artist.jpg` will be written from (§3).
 *
 * The image lookup is a second chain of requests, so it only runs when the row does not
 * already have one. An artist's picture is the single least urgent fact in the system.
 */
async function rememberArtist(
  collected: Collected,
  artist: MbArtistLike,
  fetchedAt: string,
): Promise<void> {
  const { ctx } = collected;
  const mbid = artist.id;
  if (mbid === undefined || mbid === "") return;

  const [existing] = await ctx.db
    .select()
    .from(artistsCache)
    .where(eq(artistsCache.artistMbid, mbid))
    .limit(1);

  let imageUrl = existing?.imageUrl ?? null;
  if (imageUrl === null && ctx.config.enabled.wikimedia) {
    try {
      const found = await wikimedia.artistImage(ctx, artist);
      imageUrl = found?.url ?? null;
      note(collected, {
        source: "wikimedia",
        key: `artist/${mbid}`,
        outcome: found === null ? "absent" : "hit",
        ...(found === null ? {} : { note: `via ${found.via}` }),
      });
    } catch (error) {
      note(collected, {
        source: "wikimedia",
        key: `artist/${mbid}`,
        outcome: "failed",
        note: MMError.from(error).message,
      });
    }
  }

  await ctx.db
    .insert(artistsCache)
    .values({
      artistMbid: mbid,
      name: artist.name ?? "",
      sortName: artist["sort-name"] ?? null,
      country: artist.country ?? null,
      imageUrl,
      payload: artist as unknown as Record<string, unknown>,
      fetchedAt: new Date(fetchedAt),
    })
    .onConflictDoUpdate({
      target: artistsCache.artistMbid,
      set: {
        name: artist.name ?? "",
        sortName: artist["sort-name"] ?? null,
        country: artist.country ?? null,
        imageUrl,
        payload: artist as unknown as Record<string, unknown>,
        fetchedAt: new Date(fetchedAt),
      },
    });
}

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

async function persist(
  db: Database,
  track: ImportTrack,
  document: TrackDocument,
  score: number | null,
): Promise<string> {
  const id = newId("metadataDocument");
  const [row] = await db
    .insert(metadataDocuments)
    .values({
      id,
      importTrackId: track.id,
      recordingMbid: track.recordingMbid,
      document: document as unknown as Record<string, unknown>,
      tagSchemaVersion: TAG_SCHEMA_VERSION,
      completeness: score,
    })
    .onConflictDoUpdate({
      target: metadataDocuments.importTrackId,
      set: {
        document: document as unknown as Record<string, unknown>,
        recordingMbid: track.recordingMbid,
        tagSchemaVersion: TAG_SCHEMA_VERSION,
        completeness: score,
        updatedAt: new Date(),
      },
    })
    .returning({ id: metadataDocuments.id });
  return row?.id ?? id;
}

/**
 * Overwrite one track's stored document.
 *
 * The album-scope pass is the only caller: it rewrites the 36 `albumScope` fields with the
 * album's value *after* every track has been built, which is one track later than `build`
 * can know. `completeness` is recomputed here rather than left stale, because filling a
 * field the recording had none for raises the track's own score — that is the point.
 */
export async function storeDocument(
  importTrackId: string,
  document: TrackDocument,
  db: Database = defaultDb(),
): Promise<void> {
  await db
    .update(metadataDocuments)
    .set({
      document: document as unknown as Record<string, unknown>,
      completeness: trackCompleteness(document).score,
      updatedAt: new Date(),
    })
    .where(eq(metadataDocuments.importTrackId, importTrackId));
}

/** The stored document for a track, or `null`. What `mm doc show` reads. */
export async function storedDocument(
  id: string,
  db: Database = defaultDb(),
): Promise<{
  document: TrackDocument;
  completeness: number | null;
  updatedAt: Date;
  importTrackId: string;
} | null> {
  const { track } = await resolveTrack(id, db);
  const [row] = await db
    .select()
    .from(metadataDocuments)
    .where(eq(metadataDocuments.importTrackId, track.id))
    .limit(1);
  if (row === undefined) return null;
  return {
    document: row.document as unknown as TrackDocument,
    completeness: row.completeness,
    updatedAt: row.updatedAt,
    importTrackId: track.id,
  };
}

/** Documents whose tag schema is behind the current one — the input of §8's re-tag. */
export async function documentsBehindSchema(
  db: Database = defaultDb(),
): Promise<{ id: string; importTrackId: string | null }[]> {
  return await db
    .select({ id: metadataDocuments.id, importTrackId: metadataDocuments.importTrackId })
    .from(metadataDocuments)
    .where(
      or(
        isNull(metadataDocuments.tagSchemaVersion),
        eq(metadataDocuments.tagSchemaVersion, TAG_SCHEMA_VERSION - 1),
      ),
    );
}
