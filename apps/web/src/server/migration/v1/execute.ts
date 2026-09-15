/**
 * Step 2 of the migration: do it (§ Étapes 2, 3, 4).
 *
 * Everything that writes lives here, and every write goes through `ctx.count()`. That counter
 * is not decoration: § Sécurité asks for a dry run that provably writes nothing, and the only
 * way to prove a negative is to count. A dry run never calls this module at all, and the E2E
 * asserts the counter is zero — belt, braces, and a test.
 *
 * ## Why a present track also becomes an import
 *
 * The spec creates v2 imports for the songs v1 never downloaded. This module creates one for
 * the songs it *did* download as well, marked `done`, and that deserves an explanation.
 *
 * In v2, an import track is not "a download in progress" — it is **the provenance of a file**.
 * `metadata_documents.import_track_id` is what `documents.rebuild` reads, which is what the
 * background re-tag of `docs/03-metadonnees.md` §8 runs on, which is what a tag-schema bump
 * uses to bring the library forward. A library track with no import behind it is explicitly
 * refused by `retagOne` ("was not produced by an import, so there are no sources to rebuild it
 * from"). Migrating twenty thousand files into that state would mean they could never be
 * re-tagged, re-scored or repaired — a second-class library, permanently.
 *
 * So the v1 row becomes what it always was: the record of where a file came from. The import
 * carries the v1 URL, rests at `done`, and never touches the download slot.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { and, eq, gte, inArray, sql } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import {
  merge,
  projectDocument,
  projectPictures,
  TAG_SCHEMA_VERSION,
  trackCompleteness,
  type DocumentPatch,
  type TrackDocument,
  type TrackPathInput,
} from "@mm/domain";
import type { Database } from "#/server/db/client.ts";
import {
  imports,
  importTracks,
  libraryAlbums,
  libraryTracks,
  metadataDocuments,
  type ImportOptions,
  type ImportStatus,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { containerPath, hostPath, type PathMap } from "#/server/paths.ts";
import { getOrFetch, put as cachePut } from "#/server/services/cache.ts";
import { build as buildDocument, rsgainKey, RSGAIN_SOURCE } from "#/server/services/documents.ts";
import { writeArtistImageSidecar } from "#/server/services/artist-image.ts";
import { openInboxItem } from "#/server/services/inbox.ts";
import { hashProjection, formatOf } from "#/server/services/retag.ts";
import type { Settings } from "#/server/services/settings.ts";
import type { Picture, ReplayGainResult, Tag, ToolboxClient } from "#/server/toolbox/client.ts";
import { renderPathTemplate, type DiscMode, type SanitizeMode } from "@mm/domain";
import { importStatusFor, reasonFor } from "./classify.ts";
import { movesInto, recordingMbidFor } from "./inventory.ts";
import type { PlannedAlbum, PlannedImportGroup, PlannedSong } from "./inventory.ts";
import { seedDocument } from "./seed.ts";
import { identifiersOf, sourceVideoId } from "./schema.ts";
import type { V1Song } from "./schema.ts";

export interface ExecuteContext {
  readonly db: Database;
  readonly toolbox: ToolboxClient;
  readonly settings: Settings;
  readonly paths: PathMap;
  readonly runId: string;
  readonly renameToTemplate: boolean;
  /**
   * `--keep-folders`: leave the minority files where v1 put them.
   *
   * The album row still points at the majority folder, and Navidrome still groups the tracks
   * together because it groups by tags and MBID, not by directory. What is lost is the tidy
   * one-album-one-folder library — and what is kept is every play count, because a file that
   * does not move keeps its path and therefore its Navidrome history.
   */
  readonly keepFolders: boolean;
  /** `documents.build` with the network unplugged — always true in tests and fixtures. */
  readonly offline: boolean;
  readonly signal?: AbortSignal;
  readonly now: Date;
  say(message: string, data?: Record<string, unknown>): Promise<void>;
  /** Called once per row written outside `migration_v1*`. */
  count(rows?: number): void;
}

export interface TrackOutcome {
  readonly songId: number;
  readonly path: string;
  readonly libraryTrackId: string;
  readonly documentId: string;
  readonly importTrackId: string;
  readonly importId: string;
  readonly completeness: number | null;
  readonly complete: boolean;
  readonly retagged: boolean;
  readonly sidecars: number;
  readonly renamedFrom: string | null;
  /** Where the folder consolidation moved the file from, or `null` when it did not move it. */
  readonly movedFrom: string | null;
  /** The album this track's rebuilt document claims — the release's own title, not v1's. */
  readonly album: {
    readonly title: string | null;
    readonly artist: string | null;
    readonly year: number | null;
  };
  readonly locked: readonly string[];
  /** Recommended fields the document still lacks. Reported, never fatal. */
  readonly recommendedGaps: readonly string[];
}

export interface AlbumOutcome {
  readonly albumId: string;
  readonly importId: string;
  readonly folder: string;
  readonly tracks: readonly TrackOutcome[];
  readonly replaygain: boolean;
  /** The files the consolidation actually moved, in library-relative form. */
  readonly moves: readonly { from: string; to: string }[];
  readonly failures: readonly { songId: number; path: string | null; message: string }[];
}

export interface ImportGroupOutcome {
  readonly importId: string;
  readonly status: ImportStatus;
  readonly url: string;
  readonly playlist: string | null;
  readonly tracks: readonly { songId: number; importTrackId: string; preselected: boolean }[];
  readonly inboxItems: number;
}

/* ------------------------------------------------------------------ */
/* present tracks                                                      */
/* ------------------------------------------------------------------ */

/**
 * Migrate one album: its import, its documents, its files, its sidecars, its ReplayGain.
 *
 * The order is not negotiable. The document is built before the file is touched, because the
 * file is a projection of the document and never the other way round. The tags are written
 * with `clear: true`, because that is what makes a second run leave exactly the same bytes
 * rather than the union of two projections. ReplayGain comes last, because `clear` would
 * erase it.
 */
export async function migrateAlbum(
  ctx: ExecuteContext,
  album: PlannedAlbum,
  existing: { importId?: string | null; libraryTrackIds?: ReadonlyMap<number, string> } = {},
): Promise<AlbumOutcome> {
  const importId = await upsertImport(ctx, {
    id: existing.importId ?? null,
    url: album.sourceUrl,
    kind: "album",
    status: "done",
    step: "verify",
    releaseMbid: album.releaseMbid,
    releaseGroupMbid: album.releaseGroupMbid,
    title: album.title,
    artist: album.artist,
    year: album.year,
  });

  /*
   * The folder is resolved against the database, not read off the plan.
   *
   * `library_albums.folder` is unique, so the majority folder can already belong to another
   * album row — a second release filed under the same name, or the row this regrouping is
   * about to empty. `resolveAlbum` picks the first of the album's own folders that is free,
   * and every move below aims at *that*, so the moves and the row can never disagree.
   */
  const resolved = await resolveAlbum(ctx.db, album);
  const folder = resolved.folder;
  const albumId = await upsertAlbum(ctx, album, resolved);
  // `--rename-to-template` moves every file anyway, so consolidating first would be two moves
  // for one file and two lines in the report for one decision.
  const moves = ctx.keepFolders || ctx.renameToTemplate ? [] : movesInto(album.tracks, folder);
  const moveBySong = new Map(moves.map((move) => [move.songId, move.to]));

  const outcomes: TrackOutcome[] = [];
  const failures: { songId: number; path: string | null; message: string }[] = [];

  for (const [index, planned] of album.tracks.entries()) {
    ctx.signal?.throwIfAborted();
    try {
      outcomes.push(
        await migrateTrack(ctx, {
          album,
          albumId,
          folder,
          importId,
          planned,
          index,
          moveTo: moveBySong.get(planned.song.id) ?? null,
          knownLibraryTrackId: existing.libraryTrackIds?.get(planned.song.id) ?? null,
        }),
      );
    } catch (error) {
      const failure = MMError.from(error);
      failures.push({
        songId: planned.song.id,
        path: planned.file?.path ?? null,
        message: failure.message,
      });
      await ctx.say(
        `failed: ${planned.file?.path ?? String(planned.song.id)} — ${failure.message}`,
      );
    }
  }

  /* ---- ReplayGain, once the whole album is on disk and tagged (§ Étapes 2) ---- */
  //
  // rsgain writes the tags itself, so the file is right the moment it returns. The document
  // is not: it was built before the measurement existed. So the loudness goes into the raw
  // cache and every document is rebuilt from it — exactly what `steps/tag.ts` does, and for
  // the same reason. Skipping it would leave the database claiming a projection the file no
  // longer matches, and the next library scan would report every migrated file as drifted.
  let replaygain = false;
  if (ctx.settings.replayGain && outcomes.length > 0 && failures.length === 0) {
    try {
      const scan = await ctx.toolbox.replaygain({
        files: outcomes.map((outcome) => containerPath(ctx.paths, outcome.path)),
        album: true,
        referenceLoudness: ctx.settings.replayGainReferenceLoudness,
        write: true,
      });
      await storeLoudness(ctx, outcomes, scan);
      replaygain = true;
      await ctx.say(`ReplayGain written for ${folder}`, { album: folder });
    } catch (error) {
      failures.push({
        songId: album.tracks[0]?.song.id ?? 0,
        path: folder,
        message: `ReplayGain failed: ${MMError.from(error).message}`,
      });
    }
  }

  /* ---- the documents, once more, now that the loudness exists ---- */
  const rescored = replaygain ? await rebuildAfterLoudness(ctx, album, outcomes) : outcomes;

  await refreshAlbumCounters(ctx, albumId, rescored, album);
  // Whatever the previous grouping left at a position this album no longer has. An import is
  // the provenance of exactly one album, so positions beyond its last track belong to nobody;
  // `metadata_documents` cascades with them, and `library_tracks.import_track_id` is nulled.
  await pruneImportTracks(ctx, importId, rescored.length + failures.length);

  return {
    albumId,
    importId,
    folder,
    tracks: rescored,
    replaygain,
    moves: rescored.flatMap((track) =>
      track.movedFrom === null ? [] : [{ from: track.movedFrom, to: track.path }],
    ),
    failures,
  };
}

/** Q7.8 fixed point relative to −23 LUFS, as `steps/tag.ts` computes it for Opus. */
function r128Gain(gainDb: number, referenceLoudness: number): number {
  return Math.round((gainDb + referenceLoudness + 23) * 256);
}

/** Put what rsgain measured into the raw cache, keyed the way the resolver reads it. */
async function storeLoudness(
  ctx: ExecuteContext,
  outcomes: readonly TrackOutcome[],
  scan: ReplayGainResult,
): Promise<void> {
  const reference = scan.reference_loudness;
  for (const [index, outcome] of outcomes.entries()) {
    const file = scan.files[index];
    const measured = {
      ...(file === undefined
        ? {}
        : {
            trackGain: `${file.gain.toFixed(2)} dB`,
            trackPeak: file.peak.toFixed(6),
            r128TrackGain: r128Gain(file.gain, reference),
          }),
      ...(scan.album == null
        ? {}
        : {
            albumGain: `${scan.album.gain.toFixed(2)} dB`,
            albumPeak: scan.album.peak.toFixed(6),
            r128AlbumGain: r128Gain(scan.album.gain, reference),
          }),
      referenceLoudness: `${reference.toFixed(2)} LUFS`,
    };
    await cachePut(RSGAIN_SOURCE, rsgainKey(outcome.importTrackId), measured, { db: ctx.db });
    ctx.count();
  }
}

/**
 * Rebuild every document of the album now that the loudness is cached.
 *
 * The files are **not** re-tagged: rsgain already wrote the same values into them, verbatim,
 * which is the whole reason the resolver passes them through unformatted. What changes is the
 * database's idea of the projection, and the stored hash with it.
 */
async function rebuildAfterLoudness(
  ctx: ExecuteContext,
  album: PlannedAlbum,
  outcomes: readonly TrackOutcome[],
): Promise<TrackOutcome[]> {
  const plannedBySong = new Map(album.tracks.map((planned) => [planned.song.id, planned]));
  const out: TrackOutcome[] = [];

  for (const outcome of outcomes) {
    const planned = plannedBySong.get(outcome.songId);
    if (planned === undefined) {
      out.push(outcome);
      continue;
    }
    try {
      const seed = seedDocument(planned.song, planned.forces, {
        now: ctx.now,
        releaseMbid: album.releaseMbid,
        recordingMbid: recordingMbidFor(planned),
      });
      const built = await buildDocument(outcome.importTrackId, {
        db: ctx.db,
        settings: ctx.settings,
        offline: ctx.offline,
        persist: false,
        now: ctx.now,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
      });
      const document = merge([seed.patch, asPatch(built.document)], {
        schemaVersion: TAG_SCHEMA_VERSION,
      });
      const completeness = trackCompleteness(document);
      await persistDocument(ctx, outcome.importTrackId, document, completeness.score);
      const hash = hashProjection(projectDocument(document, formatOf(outcome.path)));
      await ctx.db
        .update(libraryTracks)
        .set({ projectionHash: hash, updatedAt: ctx.now })
        .where(eq(libraryTracks.id, outcome.libraryTrackId));
      ctx.count();
      out.push({
        ...outcome,
        completeness: completeness.score,
        complete: missingRequired(completeness).length === 0,
        recommendedGaps: missingRecommended(completeness),
      });
    } catch {
      // The loudness is a refinement, not a precondition: a document that fails to rebuild
      // keeps the one the migration already stored.
      out.push(outcome);
    }
  }

  return out;
}

/**
 * The **required** fields a document is still missing, n/a excluded (`docs/03` §6).
 *
 * "Complete" for a migration means this list is empty. The phase asks for R **and** C, and
 * that bar is met for every C field but one: `acoustid` needs a fingerprint of the file and an
 * AcoustID lookup, and a migration deliberately does neither — fingerprinting twenty thousand
 * existing files is an hours-long pass with its own progress bar, and it enriches rather than
 * migrates. `recommendedGaps` below counts what is left so the gap is visible in the report
 * rather than hidden behind a definition.
 */
export function missingRequired(completeness: {
  fields: readonly { field: string; state: string; level: string }[];
}): string[] {
  return completeness.fields
    .filter((report) => report.state === "missing" && report.level === "required")
    .map((report) => report.field);
}

/** The **recommended** fields still missing — reported, not fatal. */
export function missingRecommended(completeness: {
  fields: readonly { field: string; state: string; level: string }[];
}): string[] {
  return completeness.fields
    .filter((report) => report.state === "missing" && report.level === "recommended")
    .map((report) => report.field);
}

interface TrackInput {
  readonly album: PlannedAlbum;
  readonly albumId: string;
  /** The album's resolved folder — `album.folder` adjusted for what the database already holds. */
  readonly folder: string;
  readonly importId: string;
  readonly planned: PlannedSong;
  readonly index: number;
  /** Where the consolidation wants this file, or `null` to leave it alone. */
  readonly moveTo: string | null;
  /** The `library_tracks` row a previous run wrote for this v1 song (`migration_v1`). */
  readonly knownLibraryTrackId: string | null;
}

async function migrateTrack(ctx: ExecuteContext, input: TrackInput): Promise<TrackOutcome> {
  const { planned, album, albumId, importId } = input;
  const file = planned.file;
  if (file === null) throw new MMError("UNKNOWN", "a present track with no file reached migrate");

  /* ---- 1 · the import track: the provenance row everything else hangs off ---- */
  const importTrackId = await upsertImportTrack(ctx, {
    importId,
    position: input.index,
    planned,
    role: "mapped",
    state: "done",
    libraryPath: file.path,
  });

  /* ---- 2 · the seed, from v1 alone, with the per-field overrides locked ---- */
  //
  // `album.releaseMbid` is passed because the seed's one remaining lock — the row flags, when
  // the track has no MBID at all — must be decided on the same release the rest of the
  // migration uses, `MUSICBRAINZ_ALBUMID` rung included. See `seed.ts`'s `frozenFields`.
  const seed = seedDocument(planned.song, planned.forces, {
    now: ctx.now,
    releaseMbid: album.releaseMbid,
    recordingMbid: recordingMbidFor(planned),
  });
  const seeded = merge([seed.patch], { schemaVersion: TAG_SCHEMA_VERSION });
  await persistDocument(ctx, importTrackId, seeded, trackCompleteness(seeded).score);

  /* ---- 3 · the real document, from the sources, using v1's MBIDs ---- */
  //
  // The whole chain for a migrated track, top to bottom, ends here:
  //
  //  1. the MBIDs — `identifiersOf` (a `SongForceMetadata` row, then `*Force` behind
  //     `MusicBrainzForced`, then the plain column), then the last rung, the copy v1 wrote
  //     into the file itself: `MUSICBRAINZ_ALBUMID` for the release (`releaseMbidFor`, which
  //     is `album.releaseMbid`) and `MUSICBRAINZ_TRACKID` for the recording
  //     (`recordingMbidFor`, which is `import_tracks.recording_mbid`). Both ladders are the
  //     same three rungs, and neither has a fourth;
  //  2. the release and the recording `build` actually fetches with them;
  //  3. MusicBrainz's field values, and everything hanging off them — Cover Art Archive,
  //     Deezer, LRCLIB, Last.fm;
  //  4. the v1 seed, underneath, for the gaps: it is `merge`'s *first* patch and its source is
  //     unranked, so it only ever fills what step 3 left missing;
  //  5. the `SongForceMetadata` overrides, locked, on top of all of it.
  //
  // `build` reads the locked fields of the document persisted a moment ago, so step 5 is
  // already true inside the build as well as in the merge after it — and a later
  // `documents.rebuild`, which has no seed patch to layer, reads the same locks back off the
  // stored document and answers the same thing. What v1 merely *guessed* has no lock and no
  // rank, so it loses to every source that speaks.
  //
  // A row that was migrated by an older build, with the processing flags locking everything,
  // is corrected by re-running: `persistDocument` replaces the stored document outright, so
  // step 3 above sees the new, unlocked seed.
  //
  // A failure here is **not** a failure of the track. The album's release is the one v1 chose,
  // and two ordinary things can make it unresolvable: the release is not in the cache and there
  // is no network (`--offline`, which is every fixture run), or the track's recording is simply
  // not on it — a v1 row whose recording MBID and release MBID were matched in two separate
  // passes and never agreed. Failing the album for that would lose twelve good tracks over one
  // bad pairing. Instead the track keeps the seed document, which is everything v1 knew, and the
  // question goes to the Inbox where a person can answer it.
  let built: Awaited<ReturnType<typeof buildDocument>> | null = null;
  try {
    built = await buildDocument(importTrackId, {
      db: ctx.db,
      settings: ctx.settings,
      offline: ctx.offline,
      persist: false,
      now: ctx.now,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
  } catch (error) {
    const failure = MMError.from(error);
    await ctx.say(`could not rebuild ${file.path} from its release: ${failure.message}`, {
      path: file.path,
      release: album.releaseMbid,
      document: "seed-only",
    });
    await openUnresolvedReleaseItem(ctx, {
      importId,
      importTrackId,
      planned,
      release: album.releaseMbid,
      reason: failure.message,
    });
  }

  const document =
    built === null
      ? seeded
      : merge([seed.patch, asPatch(built.document)], { schemaVersion: TAG_SCHEMA_VERSION });
  const completeness = trackCompleteness(document);
  const documentId = await persistDocument(ctx, importTrackId, document, completeness.score);

  /* ---- 4 · where the file goes: nowhere, by default (§ Étapes 3) ---- */
  //
  // Two reasons a file moves, and they are mutually exclusive by construction (`migrateAlbum`
  // plans no consolidation when the template is on). Both go through `moveInLibrary`, which
  // carries `library_tracks.path` with the file — a row left pointing at the old path is a
  // library track that no longer exists, and the next scan reports it as missing.
  let path = file.path;
  let renamedFrom: string | null = null;
  let movedFrom: string | null = null;
  if (input.moveTo !== null && input.moveTo !== path) {
    const moved = await moveInLibrary(ctx, path, input.moveTo);
    if (moved !== null) {
      movedFrom = path;
      path = moved;
      await ctx.say(`consolidated ${movedFrom} → ${path}`, { from: movedFrom, to: path });
    }
  }
  if (ctx.renameToTemplate) {
    const moved = await renameToTemplate(ctx, document, path);
    if (moved !== null) {
      renamedFrom = path;
      path = moved;
    }
  }

  /* ---- 5 · re-tag in place, at the current schema ---- */
  const format = formatOf(path);
  const tags: Tag[] = projectDocument(document, format).map((tag) => ({
    key: tag.key,
    value: tag.value,
  }));
  const pictures = await picturesFor(ctx, document, format, path);
  const lrc = syncedLyrics(document);

  /*
   * The cover the file already has is never taken away.
   *
   * `clear: true` empties the tag block, and on Opus the picture *is* a tag — which is how
   * twenty thousand embedded covers went missing. `/tag` now puts them back when no picture
   * is supplied, so this call is safe; what is left is to *say* that the document has no
   * cover of its own, because the file's picture is now the only copy and nothing in v2
   * knows where it came from.
   */
  if (file.hasPicture === true && document.fields["front_cover"] === undefined) {
    await openCoverMissingItem(ctx, { importId, importTrackId, path, planned });
  }

  await ctx.toolbox.tag({
    path: containerPath(ctx.paths, path),
    format: "auto",
    tags,
    pictures,
    lyrics_lrc: lrc,
    sidecar_lrc: false,
    clear: true,
  });
  ctx.count();

  /* ---- 6 · the sidecars of §3 ---- */
  let sidecars = writeSidecars(ctx, { path, lrc });
  /*
   * The sidecars go where the *file* is, which is not always `input.folder`.
   *
   * `library_albums.folder` is an identity as well as a location: it is unique, so two releases
   * of one record get one of them a `[6ace8918]` suffix (`freeFolder`). With
   * `--rename-to-template` the files do not follow that suffix — the template has no release
   * component — so writing `cover.jpg` into the album's folder would create a directory holding
   * a cover and nothing else. The track's own directory is where its album's artwork belongs.
   */
  const sidecarFolder = folderOfPath(path);
  // `cover.jpg` is per album, so the first track of the folder writes it and the rest find it
  // already there. v1 wrote no sidecars at all, which is why this runs on every migrated album.
  if (input.index === 0 && (await writeCover(ctx, sidecarFolder, document))) sidecars += 1;
  // `artist.jpg`, same "first track of the folder" rule as `cover.jpg` above. v1 never wrote
  // it either, and `artists_cache.imageUrl` is only ever filled by `documents.build`'s own
  // `rememberArtist` (`services/documents.ts`) — whatever this migration already looked up
  // while building the document, not a second network trip of its own.
  if (input.index === 0) {
    const artistFolder = sidecarFolder.split("/")[0] ?? "";
    const image = await writeArtistImageSidecar({
      db: ctx.db,
      toolbox: ctx.toolbox,
      paths: ctx.paths,
      artistName: albumArtistOf(document) ?? album.artist,
      artistFolder,
      size: ctx.settings.artworkSize,
      enabled: ctx.settings.writeArtistImage,
    });
    if (image.outcome === "written") sidecars += 1;
    if (image.outcome === "error") {
      await ctx.say(`no artist.jpg for ${artistFolder}: ${image.error}`, {
        folder: artistFolder,
        artistImage: "failed",
      });
    }
  }

  /* ---- 7 · the library row ---- */
  const libraryTrackId = await upsertLibraryTrack(ctx, {
    albumId,
    path,
    document,
    planned,
    importId,
    importTrackId,
    knownLibraryTrackId: input.knownLibraryTrackId,
    sizeBytes: file.sizeBytes ?? null,
    duration: file.durationSeconds ?? null,
    projectionHash: hashProjection(projectDocument(document, format)),
  });

  await ctx.db
    .update(metadataDocuments)
    .set({ libraryTrackId, updatedAt: ctx.now })
    .where(eq(metadataDocuments.importTrackId, importTrackId));
  ctx.count();

  await ctx.say(`migrated ${path}`, { path, completeness: completeness.score });

  return {
    songId: planned.song.id,
    path,
    libraryTrackId,
    documentId,
    importTrackId,
    importId,
    completeness: completeness.score,
    complete: missingRequired(completeness).length === 0,
    recommendedGaps: missingRecommended(completeness),
    retagged: true,
    sidecars,
    renamedFrom,
    movedFrom,
    album: {
      title: stringField(document, "album"),
      artist: albumArtistOf(document),
      year: yearOf(document),
    },
    locked: seed.locked,
  };
}

/* ------------------------------------------------------------------ */
/* the rows with no file                                               */
/* ------------------------------------------------------------------ */

/**
 * One v2 import for one v1 parent playlist (§ Étapes 4).
 *
 * Nothing is downloaded and nothing is queued: the import rests at `paused`, which is v2's
 * word for "complete, resumable, not running". The phase calls that state `queued`; v2 has no
 * such status, and `pending` is the one the worker picks up — which is exactly what must not
 * happen during a migration of twenty thousand rows.
 */
export async function createImportGroup(
  ctx: ExecuteContext,
  group: PlannedImportGroup,
  existing: { importId?: string | null } = {},
): Promise<ImportGroupOutcome> {
  const needsReview = group.songs.some(
    (planned) => planned.classification === "needs_manual_review",
  );
  const status: ImportStatus = needsReview ? "awaiting_review" : importStatusFor("needed");
  const first = group.songs[0]?.song;
  const releaseMbid = group.songs
    .map((planned) => identifiersOf(planned.song, planned.forces).releaseMbid)
    .find((value): value is string => value !== null);

  const importId = await upsertImport(ctx, {
    id: existing.importId ?? null,
    url: group.url,
    kind: group.kind,
    status,
    step: "resolve",
    releaseMbid: releaseMbid ?? null,
    releaseGroupMbid: null,
    title: first?.album ?? group.playlist ?? null,
    artist: first?.albumArtists[0] ?? first?.artist ?? null,
    year: first?.year ?? null,
    options: releaseMbid === undefined ? {} : { releaseMbid },
    note: `Migrated from v1${group.playlist === null ? "" : ` · playlist “${group.playlist}”`}`,
  });

  const tracks: { songId: number; importTrackId: string; preselected: boolean }[] = [];
  let inboxItems = 0;

  for (const [index, planned] of group.songs.entries()) {
    ctx.signal?.throwIfAborted();
    const ids = identifiersOf(planned.song, planned.forces);
    // These rows have no file, so the third rung has nothing to read — but the question asked
    // is the same one `import_tracks.recording_mbid` answers, so it is asked the same way.
    const recordingMbid = recordingMbidFor(planned);
    const importTrackId = await upsertImportTrack(ctx, {
      importId,
      position: index,
      planned,
      role: "mapped",
      state: "pending",
      libraryPath: null,
      note: reasonFor(planned.song, planned.classification),
    });
    const preselected = recordingMbid !== null || ids.forced.length > 0;
    tracks.push({ songId: planned.song.id, importTrackId, preselected });

    if (planned.classification === "needs_manual_review") {
      await openInboxItem(
        {
          type: "ambiguous_recording",
          importId,
          trackId: importTrackId,
          title: `v1 could not identify “${planned.song.title ?? planned.song.sourceTitle ?? planned.song.sourceUrl}”`,
          summary: reasonFor(planned.song, planned.classification),
          payload: {
            source: "migration-v1",
            v1SongId: planned.song.id,
            v1Status: planned.song.downloadStatus,
            url: planned.song.sourceUrl,
            forced: ids.forced,
          },
          ...(recordingMbid === null
            ? {}
            : { preselected: { recordingMbid, releaseMbid: ids.releaseMbid } }),
        },
        ctx.db,
      );
      ctx.count();
      inboxItems += 1;
    }
  }

  await ctx.say(
    `import ${importId}: ${String(tracks.length)} track(s) from v1${group.playlist === null ? "" : ` · ${group.playlist}`}`,
    { importId, tracks: tracks.length },
  );

  return { importId, status, url: group.url, playlist: group.playlist, tracks, inboxItems };
}

/* ------------------------------------------------------------------ */
/* the writes                                                          */
/* ------------------------------------------------------------------ */

interface UpsertImportInput {
  readonly id: string | null;
  readonly url: string;
  readonly kind: "album" | "single" | "playlist";
  readonly status: ImportStatus;
  readonly step: "resolve" | "verify";
  readonly releaseMbid: string | null;
  readonly releaseGroupMbid: string | null;
  readonly title: string | null;
  readonly artist: string | null;
  readonly year: number | null;
  readonly options?: ImportOptions;
  readonly note?: string;
}

async function upsertImport(ctx: ExecuteContext, input: UpsertImportInput): Promise<string> {
  const values = {
    url: input.url,
    kind: input.kind,
    status: input.status,
    step: input.step,
    releaseMbid: input.releaseMbid,
    releaseGroupMbid: input.releaseGroupMbid,
    title: input.title,
    artist: input.artist,
    year: input.year,
    // `options` is a closed shape (`ImportOptions`), so the migration's own provenance is not
    // smuggled into it: it lives in `import_tracks.raw` and in `migration_v1.import_id`, which
    // is where a normalised model puts it.
    options: input.options ?? {},
    updatedAt: ctx.now,
  } as const;

  if (input.id !== null) {
    const [updated] = await ctx.db
      .update(imports)
      .set(values)
      .where(eq(imports.id, input.id))
      .returning({ id: imports.id });
    ctx.count();
    if (updated !== undefined) return updated.id;
  }

  const id = newId("import");
  await ctx.db.insert(imports).values({
    id,
    ...values,
    startedAt: ctx.now,
    ...(input.status === "done" ? { finishedAt: ctx.now } : {}),
  });
  ctx.count();
  return id;
}

interface UpsertTrackInput {
  readonly importId: string;
  readonly position: number;
  readonly planned: PlannedSong;
  readonly role: "mapped" | "unmatched";
  readonly state: "done" | "pending";
  readonly libraryPath: string | null;
  readonly note?: string;
}

async function upsertImportTrack(ctx: ExecuteContext, input: UpsertTrackInput): Promise<string> {
  const { song, forces } = input.planned;
  const ids = identifiersOf(song, forces);

  const values = {
    importId: input.importId,
    position: input.position,
    videoId: sourceVideoId(song) ?? String(song.id),
    url: song.sourceUrl,
    sourceTitle: song.sourceTitle ?? song.title ?? `v1 song ${String(song.id)}`,
    sourceDuration: song.duration === null ? null : song.duration / 1000,
    role: input.role,
    state: input.state,
    /*
     * `recordingMbidFor`, not `identifiersOf`: the last rung is `MUSICBRAINZ_TRACKID` in the
     * file, and this column is what `documents.build` looks the recording up with. A row v1
     * matched and that somebody emptied afterwards would otherwise be rebuilt from its
     * release alone.
     */
    recordingMbid: recordingMbidFor(input.planned),
    trackTitle: song.title,
    trackPosition: song.trackNumber,
    mediumPosition: song.discNumber ?? 1,
    libraryPath: input.libraryPath,
    note: input.note ?? null,
    /*
     * `raw` is where the pipeline keeps the yt-dlp entry a track came from, and the document
     * builder reads it: `COMMENT` ("Source: youtu.be/… · imported <date> by Music Manager
     * <ver>"), `MUSICMANAGER_SOURCEURL` and `ORIGINALFILENAME` all come from those four keys.
     * A v1 row knows every one of them — the video id, the URL, the title, the extension — so
     * filling them here is not a fake entry, it is the same facts in the shape the resolver
     * already understands. Without it a migrated file has no `COMMENT`, which is a *required*
     * tag, and every migrated document would be incomplete for want of provenance it has.
     *
     * The v1 row itself is kept alongside, verbatim, under keys of its own.
     *
     * `thumbnail` / `thumbnails` are derived rather than stored, because v1 stored neither and
     * YouTube's thumbnail URLs are a pure function of the video id. That matters: §4's cover
     * ladder ends on the YouTube thumbnail (`youtubeThumbnail`, read straight off this entry),
     * v1 *always* fell back to it (`ProcessSongJob.cs` §9), and an entry without these keys
     * made the last rung unreachable — so a migrated track with no Cover Art Archive front
     * ended up with no cover at all, where v1 had one.
     */
    raw: {
      id: sourceVideoId(song) ?? String(song.id),
      webpage_url: song.sourceUrl,
      title: song.sourceTitle ?? song.title ?? "",
      ext: "opus",
      ...youtubeThumbnails(song),
      ...(song.sourceDescription === null ? {} : { description: song.sourceDescription }),
      source: "migration-v1",
      v1SongId: song.id,
      v1Status: song.downloadStatus,
      v1FinalFilePath: song.finalFilePath,
      v1ForcedFields: ids.forced,
      v1ErrorMessage: song.errorMessage,
    },
    updatedAt: ctx.now,
  } as const;

  const [existing] = await ctx.db
    .select({ id: importTracks.id })
    .from(importTracks)
    .where(
      and(eq(importTracks.importId, input.importId), eq(importTracks.position, input.position)),
    )
    .limit(1);

  if (existing !== undefined) {
    await ctx.db.update(importTracks).set(values).where(eq(importTracks.id, existing.id));
    ctx.count();
    return existing.id;
  }

  const id = newId("importTrack");
  await ctx.db.insert(importTracks).values({ id, ...values });
  ctx.count();
  return id;
}

/**
 * Raise `cover_missing` for a file whose picture v2 cannot account for.
 *
 * The file has a cover, the document does not: the Cover Art Archive has no front for this
 * release (or there is no release MBID at all) and the YouTube rung did not answer either.
 * Nothing is lost — the picture stays in the file — but it is now unmanaged: a re-tag cannot
 * reproduce it, `cover.jpg` will not be written, and the album page has nothing to show as
 * *the* cover. That is a question for a person, which is what the Inbox is for.
 */
async function openCoverMissingItem(
  ctx: ExecuteContext,
  input: { importId: string; importTrackId: string; path: string; planned: PlannedSong },
): Promise<void> {
  const song = input.planned.song;
  await openInboxItem(
    {
      type: "cover_missing",
      importId: input.importId,
      trackId: input.importTrackId,
      title: `“${song.title ?? song.sourceTitle ?? input.path}” has an embedded cover v2 cannot source`,
      summary:
        "The file keeps the picture v1 embedded, but no source claims it, so nothing can " +
        "re-create it and no cover.jpg was written for the album.",
      payload: {
        source: "migration-v1",
        v1SongId: song.id,
        path: input.path,
        url: song.sourceUrl,
      },
      preselected: { action: "keep_embedded" },
    },
    ctx.db,
  );
  ctx.count();
  await ctx.say(`cover_missing: ${input.path}`, { path: input.path, cover: "unsourced" });
}

/** yt-dlp's thumbnail keys for a v1 row, derived from the video id. */
interface RawThumbnails {
  readonly thumbnail?: string;
  readonly thumbnails?: readonly { url: string; width: number; height: number }[];
}

/**
 * The YouTube thumbnail URLs of a v1 row, in yt-dlp's shape.
 *
 * v1 never stored them, and it did not need to: `i.ytimg.com/vi/<id>/<name>.jpg` is a pure
 * function of the video id, which the row does have. So this is a derivation, not an
 * invention — the same image v1 embedded, at the same address.
 *
 * `thumbnail` is `hqdefault`, deliberately, even though `maxresdefault` is in the list and is
 * bigger: `youtubeThumbnail` prefers the scalar, `hqdefault` exists for every video ever
 * uploaded, and `maxresdefault` 404s on anything that was not published in HD. A migration
 * trades 480×360 for "there is a cover", every time.
 */
function youtubeThumbnails(song: V1Song): RawThumbnails {
  if (song.platform !== "YouTube") return {};
  const id = sourceVideoId(song);
  if (id === null || !/^[A-Za-z0-9_-]{6,}$/.test(id)) return {};
  const at = (name: string) => `https://i.ytimg.com/vi/${id}/${name}.jpg`;
  return {
    thumbnail: at("hqdefault"),
    thumbnails: [
      { url: at("maxresdefault"), width: 1280, height: 720 },
      { url: at("sddefault"), width: 640, height: 480 },
      { url: at("hqdefault"), width: 480, height: 360 },
    ],
  };
}

async function persistDocument(
  ctx: ExecuteContext,
  importTrackId: string,
  document: TrackDocument,
  completeness: number | null,
): Promise<string> {
  const recordingMbid = stringField(document, "musicbrainz_recordingid");
  const [existing] = await ctx.db
    .select({ id: metadataDocuments.id })
    .from(metadataDocuments)
    .where(eq(metadataDocuments.importTrackId, importTrackId))
    .limit(1);

  const values = {
    importTrackId,
    recordingMbid,
    document: document as unknown as Record<string, unknown>,
    tagSchemaVersion: TAG_SCHEMA_VERSION,
    completeness,
    updatedAt: ctx.now,
  } as const;

  if (existing !== undefined) {
    await ctx.db.update(metadataDocuments).set(values).where(eq(metadataDocuments.id, existing.id));
    ctx.count();
    return existing.id;
  }

  const id = newId("metadataDocument");
  await ctx.db.insert(metadataDocuments).values({ id, ...values });
  ctx.count();
  return id;
}

/** Which `library_albums` row an album is, and which folder it is allowed to claim. */
export interface ResolvedAlbum {
  /** The row that already exists for this album, or `null` when there is none yet. */
  readonly id: string | null;
  /** The album's folder: its majority folder, or the first of its folders that is free. */
  readonly folder: string;
}

/**
 * Find the `library_albums` row an album belongs to, writing nothing.
 *
 * The lookup follows the grouping. A release-grouped album is **its release MBID**, so that is
 * the key: re-running a migration that used to group by tags finds the one row per release and
 * pulls every stray track into it, which is the whole point of the regrouping. Only when no row
 * carries that release is the folder tried, and then only if the row there is not already
 * another release's album — otherwise a regrouping would quietly annex somebody else's album.
 *
 * A `tags` album has no release to key on and keeps the folder lookup it always had.
 *
 * Exported because `run.ts` needs the same answer *before* deciding whether an album can be
 * skipped, and two implementations of "which row is this" would eventually disagree.
 */
export async function resolveAlbum(db: Database, album: PlannedAlbum): Promise<ResolvedAlbum> {
  let id: string | null = null;

  if (album.groupedBy === "release_mbid" && album.releaseMbid !== null) {
    const rows = await db
      .select({ id: libraryAlbums.id, folder: libraryAlbums.folder })
      .from(libraryAlbums)
      .where(eq(libraryAlbums.releaseMbid, album.releaseMbid))
      .orderBy(libraryAlbums.createdAt);
    // Several rows can carry one release: that is exactly the state a tag-grouped migration
    // left behind, and the one this regrouping dissolves. The row already sitting in the
    // album's majority folder is the one to keep, so the surviving album is the one holding
    // most of the files and the minority is what moves — the other way round would move three
    // files to join two.
    id = (rows.find((row) => row.folder === album.folder) ?? rows[0])?.id ?? null;
  }

  if (id === null) {
    const [row] = await db
      .select({ id: libraryAlbums.id, releaseMbid: libraryAlbums.releaseMbid })
      .from(libraryAlbums)
      .where(eq(libraryAlbums.folder, album.folder))
      .limit(1);
    const free =
      row !== undefined &&
      (album.groupedBy === "tags" ||
        row.releaseMbid === null ||
        row.releaseMbid === album.releaseMbid);
    id = free ? (row?.id ?? null) : null;
  }

  return { id, folder: await freeFolder(db, album, id) };
}

/**
 * What tells two albums apart when their folders would be the same word.
 *
 * The release MBID's first eight characters, because that is what the two albums actually
 * *differ by* and it is stable for ever: the same release gets the same suffix on every run,
 * on every machine, with or without a network. Eight hex characters is 4 billion, which is
 * more than enough to separate two releases of one record and short enough to read.
 *
 * A `tags` album has no release to name, so it is keyed on the grouping key it was built from
 * — which already contains its v1 folder and is therefore unique among the plan's albums.
 */
export function folderSuffixOf(album: PlannedAlbum): string {
  if (album.groupedBy === "release_mbid" && album.releaseMbid !== null) {
    return album.releaseMbid.replace(/-/g, "").slice(0, 8);
  }
  return createHash("sha1").update(album.key).digest("hex").slice(0, 8);
}

/** `Imagine Dragons/Smoke + Mirrors (2015)` → `… (2015) [6ace8918]`. */
export function disambiguatedFolder(album: PlannedAlbum, folder: string): string {
  return `${folder} [${folderSuffixOf(album)}]`;
}

/**
 * A folder no *other* album row holds.
 *
 * `library_albums.folder` is **unique**, and that is not a detail: the rule of P11.1 is one
 * album row per v1 release MBID, while the folder is rendered from (album artist, title,
 * year) — so two releases of one record render the *same* path and the second insert is
 * rejected by `library_albums_folder_idx`. On a real library that killed a five-thousand-song
 * migration eighty minutes in, with `Imagine Dragons — Smoke + Mirrors` as the pair that did
 * it (releases `6ace8918…` and `1c801841…`).
 *
 * So the candidates are the album's own v1 folders in majority order — the answer in every
 * ordinary case — and then the same folders **disambiguated by the release**. The last resort
 * is the disambiguated majority folder rather than the bare one: a suffix nobody else can
 * produce is always a better answer than a collision.
 *
 * Idempotent by construction. `resolveAlbum` binds the row by its release MBID before this
 * runs, so a second migration finds the album already sitting in `… [6ace8918]`, recognises it
 * as its own (`row.id === selfId`) and returns it unchanged — no second suffix, no move.
 */
async function freeFolder(
  db: Database,
  album: PlannedAlbum,
  selfId: string | null,
): Promise<string> {
  const own =
    album.folders.length === 0 ? [album.folder] : album.folders.map((entry) => entry.folder);
  const candidates = [...own, ...own.map((folder) => disambiguatedFolder(album, folder))];
  for (const folder of candidates) {
    const [row] = await db
      .select({ id: libraryAlbums.id })
      .from(libraryAlbums)
      .where(eq(libraryAlbums.folder, folder))
      .limit(1);
    if (row === undefined || row.id === selfId) return folder;
  }
  return disambiguatedFolder(album, own[0] ?? album.folder);
}

async function upsertAlbum(
  ctx: ExecuteContext,
  album: PlannedAlbum,
  resolved: ResolvedAlbum,
): Promise<string> {
  const values = {
    releaseMbid: album.releaseMbid,
    releaseGroupMbid: album.releaseGroupMbid,
    albumArtist: album.artist,
    title: album.title,
    year: album.year,
    folder: resolved.folder,
    trackCount: album.tracks.length,
    presentCount: album.tracks.length,
    updatedAt: ctx.now,
  } as const;

  if (resolved.id !== null) {
    await ctx.db.update(libraryAlbums).set(values).where(eq(libraryAlbums.id, resolved.id));
    ctx.count();
    return resolved.id;
  }

  const id = newId("libraryAlbum");
  await ctx.db.insert(libraryAlbums).values({ id, ...values });
  ctx.count();
  return id;
}

/**
 * Move a file inside the library, carrying its `library_tracks` row with it.
 *
 * The rename is within one mount, so it is atomic — the same property `place` relies on. The
 * row update is what keeps the database honest: a `library_tracks.path` left behind points at a
 * file that is not there, and the next scan reports a track as missing and its new location as
 * an orphan. Returns the new path, or `null` when the move could not be made safely.
 */
async function moveInLibrary(
  ctx: ExecuteContext,
  current: string,
  target: string,
): Promise<string | null> {
  const from = hostPath(ctx.paths, current);
  const to = hostPath(ctx.paths, target);
  if (!existsSync(from) || existsSync(to)) return null;
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  await ctx.db
    .update(libraryTracks)
    .set({ path: target, updatedAt: ctx.now })
    .where(eq(libraryTracks.path, current));
  ctx.count();
  return target;
}

/**
 * Drop the import tracks of an album's import beyond its last position.
 *
 * An import is the provenance of exactly one album, and `migrateAlbum` writes positions
 * `0…n-1`. Anything past that is what a *previous* grouping left there, pointing at a track
 * this album no longer contains. `metadata_documents` cascades with the row; a `library_tracks`
 * row still referencing it has already been re-pointed at its new import track by the album
 * that adopted it, and the foreign key nulls the column if one somehow has not.
 */
async function pruneImportTracks(
  ctx: ExecuteContext,
  importId: string,
  keep: number,
): Promise<void> {
  const stale = await ctx.db
    .select({ id: importTracks.id })
    .from(importTracks)
    .where(and(eq(importTracks.importId, importId), gte(importTracks.position, keep)));
  if (stale.length === 0) return;
  await ctx.db.delete(importTracks).where(
    inArray(
      importTracks.id,
      stale.map((row) => row.id),
    ),
  );
  ctx.count(stale.length);
}

interface UpsertLibraryTrackInput {
  readonly albumId: string;
  readonly path: string;
  readonly document: TrackDocument;
  readonly planned: PlannedSong;
  readonly importId: string;
  readonly importTrackId: string;
  readonly sizeBytes: number | null;
  readonly duration: number | null;
  readonly projectionHash: string;
  /** What `migration_v1` remembers this v1 song's `library_tracks` row to be. */
  readonly knownLibraryTrackId: string | null;
}

/**
 * Whether a document's `tracknumber` is a fact about **this album** or a leftover of v1's.
 *
 * `documents.build` sets it from `track.position` on the release it resolved
 * (`resolvers/musicbrainz.ts`), and that is the only value that describes the album the
 * regrouping just built. The v1 seed sets the same field from `Songs.TrackNumber`
 * (`seed.ts`), which describes *the folder v1 filed the row in* — and v1 filed one release
 * into several folders, each numbered from 1. Carrying that number into the regrouped album
 * is what made two tracks claim position 1.
 */
function positionIsFromRelease(document: TrackDocument): boolean {
  const source = document.fields["tracknumber"]?.source;
  return source !== undefined && source !== "v1";
}

/**
 * The position a track takes inside its `library_albums` row, and never a collision.
 *
 * `library_tracks_album_position_idx` is unique over
 * `(album_id, coalesce(disc_number, 1), track_number)`, so two tracks claiming one position
 * is not a cosmetic problem: the second write is *rejected*, `migrateAlbum` catches it as a
 * track failure, and the track is left behind in the album row the regrouping is dissolving —
 * with its file already moved into the new folder. That is the incident this function exists
 * to stop, so the rule is decided here rather than hoped for:
 *
 *  1. **the release's own position wins**, whenever the rebuild found the track on it;
 *  2. a row that already sits in this album keeps the position it has, which is what makes a
 *     second run a no-op rather than a renumbering;
 *  3. a free v1 position is taken as-is — an album nothing could be looked up for keeps v1's
 *     numbering, which is the only numbering anybody has;
 *  4. and a **taken** one is refused: the track goes past the end of the album instead, at
 *     the first free position above the highest one the album currently holds.
 *
 * Deterministic in all four cases: the album's tracks are processed in `byPosition` order,
 * which is stable, so the same library regrouped twice produces the same numbering.
 */
async function albumPosition(
  ctx: ExecuteContext,
  input: {
    readonly albumId: string;
    readonly trackId: string | null;
    readonly discNumber: number | null;
    readonly candidate: number | null;
    readonly fromRelease: boolean;
  },
): Promise<number | null> {
  const disc = input.discNumber ?? 1;
  const onDisc = and(
    eq(libraryTracks.albumId, input.albumId),
    sql`coalesce(${libraryTracks.discNumber}, 1) = ${disc}`,
  );

  /** Free means: nobody holds it, or the only holder is the row we are about to write. */
  const free = async (position: number): Promise<boolean> => {
    const rows = await ctx.db
      .select({ id: libraryTracks.id })
      .from(libraryTracks)
      .where(and(onDisc, eq(libraryTracks.trackNumber, position)));
    return rows.every((row) => row.id === input.trackId);
  };

  if (input.fromRelease && input.candidate !== null && (await free(input.candidate))) {
    return input.candidate;
  }

  if (input.trackId !== null) {
    const [held] = await ctx.db
      .select({ albumId: libraryTracks.albumId, trackNumber: libraryTracks.trackNumber })
      .from(libraryTracks)
      .where(eq(libraryTracks.id, input.trackId))
      .limit(1);
    if (
      held !== undefined &&
      held.albumId === input.albumId &&
      held.trackNumber !== null &&
      (await free(held.trackNumber))
    ) {
      return held.trackNumber;
    }
  }

  if (input.candidate !== null && (await free(input.candidate))) return input.candidate;

  const [highest] = await ctx.db
    .select({ max: sql<number | null>`max(${libraryTracks.trackNumber})` })
    .from(libraryTracks)
    .where(onDisc);
  let next = Math.max(highest?.max ?? 0, input.candidate ?? 0) + 1;
  // A loop rather than `max + 1` alone, because `max` is read before this write and two
  // tracks of one album are written one after the other.
  while (!(await free(next))) next += 1;
  return next;
}

async function upsertLibraryTrack(
  ctx: ExecuteContext,
  input: UpsertLibraryTrackInput,
): Promise<string> {
  const { document, planned } = input;

  /*
   * Which row this is, in two rungs.
   *
   * The path is the first, and it used to be the only one — which made the migration insert a
   * *second* row whenever the file had moved behind the app's back: the row kept its stale
   * path in the old album, the insert made a new one in the new album, and one song came out
   * under two albums with one of the two pointing at nothing. `migration_v1.library_track_id`
   * is what the previous run wrote for this very v1 song, so it is the identity the path
   * cannot be; it is only trusted when the row is still there and nothing else holds the path
   * we are about to write.
   */
  const [byPath] = await ctx.db
    .select({ id: libraryTracks.id })
    .from(libraryTracks)
    .where(eq(libraryTracks.path, input.path))
    .limit(1);

  let existing = byPath;
  if (existing === undefined && input.knownLibraryTrackId !== null) {
    const [known] = await ctx.db
      .select({ id: libraryTracks.id })
      .from(libraryTracks)
      .where(eq(libraryTracks.id, input.knownLibraryTrackId))
      .limit(1);
    existing = known;
  }

  const discNumber = numberField(document, "discnumber") ?? planned.song.discNumber;
  const trackNumber = await albumPosition(ctx, {
    albumId: input.albumId,
    trackId: existing?.id ?? null,
    discNumber,
    candidate: numberField(document, "tracknumber") ?? planned.song.trackNumber,
    fromRelease: positionIsFromRelease(document),
  });

  const values = {
    albumId: input.albumId,
    recordingMbid: stringField(document, "musicbrainz_recordingid"),
    trackMbid: stringField(document, "musicbrainz_releasetrackid"),
    title: stringField(document, "title") ?? planned.song.title ?? "Unknown",
    artist: stringField(document, "artist") ?? planned.song.artist,
    discNumber,
    trackNumber,
    path: input.path,
    format: input.path.split(".").pop() ?? null,
    size: input.sizeBytes,
    duration: input.duration,
    tagSchemaVersion: TAG_SCHEMA_VERSION,
    projectionHash: input.projectionHash,
    importId: input.importId,
    importTrackId: input.importTrackId,
    updatedAt: ctx.now,
  } as const;

  if (existing !== undefined) {
    await ctx.db.update(libraryTracks).set(values).where(eq(libraryTracks.id, existing.id));
    ctx.count();
    return existing.id;
  }

  const id = newId("libraryTrack");
  await ctx.db.insert(libraryTracks).values({ id, ...values });
  ctx.count();
  return id;
}

/**
 * Bring the album row in line with what the tracks turned out to be.
 *
 * Title, album artist and year come from the **rebuilt documents**, not from the plan: the plan
 * only ever held one v1 row's tags, and those are exactly what disagreed across a release in
 * the first place. `documents.build` resolved the release, so the tracks now all carry the
 * release's own `ALBUM`, `ALBUMARTIST` and `DATE`, and the most common value among them is the
 * album's. v1's guess is kept as the fallback for a release nothing could be looked up for.
 */
async function refreshAlbumCounters(
  ctx: ExecuteContext,
  albumId: string,
  tracks: readonly TrackOutcome[],
  album: PlannedAlbum,
): Promise<void> {
  const scores = tracks
    .map((track) => track.completeness)
    .filter((score): score is number => score !== null);
  const mean =
    scores.length === 0 ? null : scores.reduce((sum, value) => sum + value, 0) / scores.length;
  const cover = tracks[0] === undefined ? null : `${folderOfPath(tracks[0].path)}/cover.jpg`;

  await ctx.db
    .update(libraryAlbums)
    .set({
      title: commonest(tracks.map((track) => track.album.title)) ?? album.title,
      albumArtist: commonest(tracks.map((track) => track.album.artist)) ?? album.artist,
      year: commonest(tracks.map((track) => track.album.year)) ?? album.year,
      trackCount: tracks.length,
      presentCount: tracks.length,
      completeness: mean,
      ...(cover !== null && existsSync(hostPath(ctx.paths, cover)) ? { coverPath: cover } : {}),
      updatedAt: ctx.now,
    })
    .where(eq(libraryAlbums.id, albumId));
  ctx.count();
}

/**
 * The value most of the tracks agree on, `null` when none of them has one.
 *
 * Ties go to the value that appeared first, which is the lowest disc-and-track position — an
 * arbitrary but stable rule, so two runs over one album never produce two different titles.
 */
function commonest<T extends string | number>(values: readonly (T | null)[]): T | null {
  const counts = new Map<T, number>();
  for (const value of values) {
    if (value === null) continue;
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* files                                                               */
/* ------------------------------------------------------------------ */

/**
 * `--rename-to-template` (§ Étapes 3).
 *
 * Off by default, and loudly: Navidrome identifies a file by its path, so renaming one loses
 * its play counts and its favourites. The caller has already printed the warning; this
 * function only does the move, and only when the new path is both different and free.
 */
async function renameToTemplate(
  ctx: ExecuteContext,
  document: TrackDocument,
  current: string,
): Promise<string | null> {
  const extension = current.split(".").pop() ?? "opus";
  const input: TrackPathInput = {
    albumArtist:
      stringField(document, "albumartist") ?? stringField(document, "artist") ?? "Unknown Artist",
    album: stringField(document, "album") ?? "Unknown Album",
    ...(yearOf(document) === null ? {} : { year: yearOf(document) as number }),
    ...(numberField(document, "discnumber") === null
      ? {}
      : { discNumber: numberField(document, "discnumber") as number }),
    ...(numberField(document, "totaldiscs") === null
      ? {}
      : { totalDiscs: numberField(document, "totaldiscs") as number }),
    trackNumber: numberField(document, "tracknumber") ?? 1,
    title: stringField(document, "title") ?? "Unknown",
    extension,
  };

  const target = renderPathTemplate(ctx.settings.pathTemplate, input, {
    mode: ctx.settings.sanitizeMode as SanitizeMode,
    discMode: ctx.settings.discMode as DiscMode,
  });
  if (target === current) return null;
  return await moveInLibrary(ctx, current, target);
}

interface SidecarInput {
  readonly path: string;
  readonly lrc: string | null;
}

/** The `.lrc` beside the track (§3). Returns how many files it wrote. */
function writeSidecars(ctx: ExecuteContext, input: SidecarInput): number {
  let written = 0;

  if (ctx.settings.writeLyricsSidecar && input.lrc !== null && input.lrc !== "") {
    const target = hostPath(ctx.paths, input.path.replace(/\.[^./]+$/, ".lrc"));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, input.lrc.endsWith("\n") ? input.lrc : `${input.lrc}\n`, "utf8");
    written += 1;
  }

  return written;
}

/** `cover.jpg` for the album, from the cached artwork. Once per album, never re-fetched. */
export async function writeCover(
  ctx: ExecuteContext,
  folder: string,
  document: TrackDocument,
): Promise<boolean> {
  if (!ctx.settings.writeCover) return false;
  const url = coverUrl(document);
  if (url === null) return false;
  const target = hostPath(ctx.paths, `${folder}/cover.jpg`);
  if (existsSync(target)) return false;

  try {
    const prepared = await preparedArtwork(ctx, url);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, Buffer.from(prepared.data_base64, "base64"));
    return true;
  } catch (error) {
    // No artwork cached and no network: the album keeps whatever v1 embedded in its files.
    // Silence was the bug — a cover that failed to materialise left no trace anywhere, so
    // nobody could tell "the album never had one" from "the fetch failed". The journal now
    // says which, and the migration still does not fail on it.
    await ctx.say(`no cover.jpg for ${folder}: ${MMError.from(error).message}`, {
      folder,
      cover: "failed",
    });
    return false;
  }
}

export async function picturesFor(
  ctx: ExecuteContext,
  document: TrackDocument,
  format: ReturnType<typeof formatOf>,
  path?: string,
): Promise<Picture[]> {
  if (!ctx.settings.embedArtwork) return [];
  const out: Picture[] = [];
  for (const picture of projectPictures(document, format)) {
    try {
      const prepared = await preparedArtwork(ctx, picture.url);
      out.push({
        type: picture.kind === "back" ? 4 : 3,
        mime: prepared.mime,
        data_base64: prepared.data_base64,
        description: picture.comment ?? "",
      });
    } catch (error) {
      // Re-fetching a picture is a network call a migration must not depend on, so a failure
      // here is not fatal — but it is not invisible either. It goes in the journal, and the
      // picture already in the file survives regardless: `/tag` re-attaches what it finds
      // when no replacement is supplied (`keep_pictures`).
      await ctx.say(`could not prepare ${picture.kind} cover: ${MMError.from(error).message}`, {
        ...(path === undefined ? {} : { path }),
        kind: picture.kind,
        picture: "failed",
      });
    }
  }
  return out;
}

/**
 * One prepared cover, through the raw cache — never fetched twice for the same URL and size.
 *
 * A `data:` URL is decoded here rather than handed to the toolbox: the bytes are already in
 * hand (that is what `data:` means), `/artwork/prepare` would have to fetch a URL that no
 * server serves, and caching a megabyte-long cache *key* would be its own kind of silly. This
 * is the path the v1 forced cover (`SongForceMetadata.CoverArtBytes`) takes.
 */
async function preparedArtwork(
  ctx: ExecuteContext,
  url: string,
): Promise<{ data_base64: string; mime: string }> {
  const inline = decodeDataUrl(url);
  if (inline !== null) return inline;
  const entry = await getOrFetch(
    "artwork",
    `${url}#${String(ctx.settings.artworkSize)}`,
    async () => {
      const prepared = await ctx.toolbox.prepareArtwork({ url, size: ctx.settings.artworkSize });
      return { data_base64: prepared.data_base64, mime: prepared.mime };
    },
    { db: ctx.db },
  );
  return entry.data;
}

/** `data:image/jpeg;base64,…` → the bytes, still base64. Anything else → `null`. */
export function decodeDataUrl(url: string): { data_base64: string; mime: string } | null {
  const match = /^data:([^;,]*);base64,([\s\S]+)$/.exec(url);
  if (match === null) return null;
  const data = (match[2] ?? "").replace(/\s+/g, "");
  if (data === "") return null;
  return {
    data_base64: data,
    mime: match[1] === undefined || match[1] === "" ? "image/jpeg" : match[1],
  };
}

/* ------------------------------------------------------------------ */
/* small readers over a document                                       */
/* ------------------------------------------------------------------ */

function asPatch(document: TrackDocument): DocumentPatch {
  return { fields: document.fields, na: document.na };
}

export function stringField(document: TrackDocument, name: string): string | null {
  const value = document.fields[name]?.value;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

export function numberField(document: TrackDocument, name: string): number | null {
  const value = document.fields[name]?.value;
  if (typeof value === "number") return value;
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function yearOf(document: TrackDocument): number | null {
  const date = stringField(document, "date") ?? stringField(document, "originaldate");
  if (date === null) return null;
  const parsed = Number.parseInt(date.slice(0, 4), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function coverUrl(document: TrackDocument): string | null {
  const value = document.fields["front_cover"]?.value;
  if (!Array.isArray(value)) return null;
  const first = value[0];
  if (typeof first !== "object" || first === null) return null;
  const url = (first as { url?: unknown }).url;
  return typeof url === "string" ? url : null;
}

function syncedLyrics(document: TrackDocument): string | null {
  const held = document.fields["lyrics"]?.value;
  if (typeof held !== "object" || held === null || Array.isArray(held)) return null;
  const value = held as { synced?: string | null; plain?: string | null };
  return value.synced ?? null;
}

function folderOfPath(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/**
 * The album artist a document claims, preferring the list over the joined string.
 *
 * `albumartists` is the modelled value; `albumartist` is the single-string projection of it.
 * Reading the list first keeps the album row saying what the release says rather than what a
 * join phrase happened to render.
 */
function albumArtistOf(document: TrackDocument): string | null {
  const list = document.fields["albumartists"]?.value;
  if (Array.isArray(list) && typeof list[0] === "string" && list[0] !== "") return list[0];
  return stringField(document, "albumartist") ?? stringField(document, "artist");
}

/**
 * Raise `ambiguous_release` for a track whose album release could not be resolved.
 *
 * The album is its v1 release MBID, so this is the one question the grouping cannot answer by
 * itself: either the release is unknown to this installation (nothing cached, no network) or
 * the track's recording is not on it. Either way the file is fine, the tags are v1's, and what
 * is missing is a decision — which is what the Inbox holds.
 */
async function openUnresolvedReleaseItem(
  ctx: ExecuteContext,
  input: {
    importId: string;
    importTrackId: string;
    planned: PlannedSong;
    release: string | null;
    reason: string;
  },
): Promise<void> {
  const song = input.planned.song;
  const recordingMbid = recordingMbidFor(input.planned);
  await openInboxItem(
    {
      type: "ambiguous_release",
      importId: input.importId,
      trackId: input.importTrackId,
      title: `“${song.title ?? song.sourceTitle ?? song.sourceUrl}” could not be rebuilt from its v1 release`,
      summary:
        `The album is keyed on release ${input.release ?? "(none)"}, and the rebuild did not ` +
        `complete: ${input.reason}. The track keeps the tags v1 wrote and is otherwise migrated.`,
      payload: {
        source: "migration-v1",
        v1SongId: song.id,
        releaseMbid: input.release,
        recordingMbid,
        reason: input.reason,
      },
      ...(recordingMbid === null
        ? {}
        : { preselected: { recordingMbid, releaseMbid: input.release } }),
    },
    ctx.db,
  );
  ctx.count();
}
