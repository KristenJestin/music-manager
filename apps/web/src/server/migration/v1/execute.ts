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
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { and, eq } from "drizzle-orm";
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
import { openInboxItem } from "#/server/services/inbox.ts";
import { hashProjection, formatOf } from "#/server/services/retag.ts";
import type { Settings } from "#/server/services/settings.ts";
import type { Picture, ReplayGainResult, Tag, ToolboxClient } from "#/server/toolbox/client.ts";
import { renderPathTemplate, type DiscMode, type SanitizeMode } from "@mm/domain";
import { importStatusFor, reasonFor } from "./classify.ts";
import type { PlannedAlbum, PlannedImportGroup, PlannedSong } from "./inventory.ts";
import { seedDocument } from "./seed.ts";
import { identifiersOf, sourceVideoId } from "./schema.ts";

export interface ExecuteContext {
  readonly db: Database;
  readonly toolbox: ToolboxClient;
  readonly settings: Settings;
  readonly paths: PathMap;
  readonly runId: string;
  readonly renameToTemplate: boolean;
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
  existing: { importId?: string | null } = {},
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

  const albumId = await upsertAlbum(ctx, album);
  const outcomes: TrackOutcome[] = [];
  const failures: { songId: number; path: string | null; message: string }[] = [];

  for (const [index, planned] of album.tracks.entries()) {
    ctx.signal?.throwIfAborted();
    try {
      outcomes.push(await migrateTrack(ctx, { album, albumId, importId, planned, index }));
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
      await ctx.say(`ReplayGain written for ${album.folder}`, { album: album.folder });
    } catch (error) {
      failures.push({
        songId: album.tracks[0]?.song.id ?? 0,
        path: album.folder,
        message: `ReplayGain failed: ${MMError.from(error).message}`,
      });
    }
  }

  /* ---- the documents, once more, now that the loudness exists ---- */
  const rescored = replaygain ? await rebuildAfterLoudness(ctx, album, outcomes) : outcomes;

  await refreshAlbumCounters(ctx, albumId, rescored);

  return { albumId, importId, folder: album.folder, tracks: rescored, replaygain, failures };
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
      const seed = seedDocument(planned.song, planned.forces, { now: ctx.now });
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
  readonly importId: string;
  readonly planned: PlannedSong;
  readonly index: number;
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

  /* ---- 2 · the seed, from v1 alone, with the forced fields locked ---- */
  const seed = seedDocument(planned.song, planned.forces, { now: ctx.now });
  const seeded = merge([seed.patch], { schemaVersion: TAG_SCHEMA_VERSION });
  await persistDocument(ctx, importTrackId, seeded, trackCompleteness(seeded).score);

  /* ---- 3 · the real document, from the sources, using v1's MBIDs ---- */
  //
  // `build` reads the locked fields of the document already stored, so what v1's owner forced
  // survives the rebuild. What v1 merely *guessed* does not: it is merged back underneath the
  // built document afterwards, so it only ever fills a hole the sources left.
  const built = await buildDocument(importTrackId, {
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
  const documentId = await persistDocument(ctx, importTrackId, document, completeness.score);

  /* ---- 4 · where the file goes: nowhere, by default (§ Étapes 3) ---- */
  let path = file.path;
  let renamedFrom: string | null = null;
  if (ctx.renameToTemplate) {
    const moved = renameToTemplate(ctx, document, path);
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
  const pictures = await picturesFor(ctx, document, format);
  const lrc = syncedLyrics(document);

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
  // `cover.jpg` is per album, so the first track of the folder writes it and the rest find it
  // already there. v1 wrote no sidecars at all, which is why this runs on every migrated album.
  if (input.index === 0 && (await writeCover(ctx, album.folder, document))) sidecars += 1;

  /* ---- 7 · the library row ---- */
  const libraryTrackId = await upsertLibraryTrack(ctx, {
    albumId,
    path,
    document,
    planned,
    importId,
    importTrackId,
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
    const importTrackId = await upsertImportTrack(ctx, {
      importId,
      position: index,
      planned,
      role: "mapped",
      state: "pending",
      libraryPath: null,
      note: reasonFor(planned.song, planned.classification),
    });
    const preselected = ids.recordingMbid !== null || ids.forced.length > 0;
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
          ...(ids.recordingMbid === null
            ? {}
            : { preselected: { recordingMbid: ids.recordingMbid, releaseMbid: ids.releaseMbid } }),
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
    recordingMbid: ids.recordingMbid,
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
     */
    raw: {
      id: sourceVideoId(song) ?? String(song.id),
      webpage_url: song.sourceUrl,
      title: song.sourceTitle ?? song.title ?? "",
      ext: "opus",
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

async function upsertAlbum(ctx: ExecuteContext, album: PlannedAlbum): Promise<string> {
  const values = {
    releaseMbid: album.releaseMbid,
    releaseGroupMbid: album.releaseGroupMbid,
    albumArtist: album.artist,
    title: album.title,
    year: album.year,
    folder: album.folder,
    trackCount: album.tracks.length,
    presentCount: album.tracks.length,
    updatedAt: ctx.now,
  } as const;

  const [existing] = await ctx.db
    .select({ id: libraryAlbums.id })
    .from(libraryAlbums)
    .where(eq(libraryAlbums.folder, album.folder))
    .limit(1);

  if (existing !== undefined) {
    await ctx.db.update(libraryAlbums).set(values).where(eq(libraryAlbums.id, existing.id));
    ctx.count();
    return existing.id;
  }

  const id = newId("libraryAlbum");
  await ctx.db.insert(libraryAlbums).values({ id, ...values });
  ctx.count();
  return id;
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
}

async function upsertLibraryTrack(
  ctx: ExecuteContext,
  input: UpsertLibraryTrackInput,
): Promise<string> {
  const { document, planned } = input;
  const values = {
    albumId: input.albumId,
    recordingMbid: stringField(document, "musicbrainz_recordingid"),
    trackMbid: stringField(document, "musicbrainz_releasetrackid"),
    title: stringField(document, "title") ?? planned.song.title ?? "Unknown",
    artist: stringField(document, "artist") ?? planned.song.artist,
    discNumber: numberField(document, "discnumber") ?? planned.song.discNumber,
    trackNumber: numberField(document, "tracknumber") ?? planned.song.trackNumber,
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

  const [existing] = await ctx.db
    .select({ id: libraryTracks.id })
    .from(libraryTracks)
    .where(eq(libraryTracks.path, input.path))
    .limit(1);

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

async function refreshAlbumCounters(
  ctx: ExecuteContext,
  albumId: string,
  tracks: readonly TrackOutcome[],
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
      trackCount: tracks.length,
      presentCount: tracks.length,
      completeness: mean,
      ...(cover !== null && existsSync(hostPath(ctx.paths, cover)) ? { coverPath: cover } : {}),
      updatedAt: ctx.now,
    })
    .where(eq(libraryAlbums.id, albumId));
  ctx.count();
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
function renameToTemplate(
  ctx: ExecuteContext,
  document: TrackDocument,
  current: string,
): string | null {
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

  const from = hostPath(ctx.paths, current);
  const to = hostPath(ctx.paths, target);
  if (!existsSync(from) || existsSync(to)) return null;

  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return target;
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
  } catch {
    // No artwork cached and no network: the album keeps whatever v1 embedded in its files.
    return false;
  }
}

async function picturesFor(
  ctx: ExecuteContext,
  document: TrackDocument,
  format: ReturnType<typeof formatOf>,
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
    } catch {
      // The picture v1 embedded is already in the file, and re-fetching one is a network call
      // a migration must not depend on. The gap shows up in the album's completeness score,
      // which is where a missing cover belongs — not in a failed migration.
    }
  }
  return out;
}

/** One prepared cover, through the raw cache — never fetched twice for the same URL and size. */
async function preparedArtwork(
  ctx: ExecuteContext,
  url: string,
): Promise<{ data_base64: string; mime: string }> {
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
