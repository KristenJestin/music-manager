/**
 * `mm migrate v1` — the whole thing, from end to end (`docs/phases/P11-migration-v1.md`).
 *
 * The shape of a run:
 *
 *  1. **preflight** — resolve the two library roots, refuse to touch a live library without an
 *     acknowledged backup, open the v1 database read-only;
 *  2. **inventory** — read `Songs`, walk the files, probe them, reconcile, classify (`inventory.ts`);
 *  3. **execute** — albums first, then the imports for what v1 never downloaded (`execute.ts`);
 *  4. **playlists** — one M3U each, next to the library, and nothing in the database;
 *  5. **verify** — read each migrated album back through Navidrome, when there is one;
 *  6. **report** — counters, discrepancies, errors, as JSON and as text.
 *
 * Three properties are load-bearing and are tested rather than asserted in prose:
 *
 *  - **Idempotent.** State lives in `migration_v1`, keyed by the v1 song id and the path it
 *    ended at. A second run over an unchanged library does nothing at all.
 *  - **Resumable.** Every row is committed as it is finished, so an interrupted run resumes
 *    where it stopped rather than from the beginning.
 *  - **A dry run writes nothing.** It never reaches `execute.ts`, and the run row carries a
 *    counter of rows written outside `migration_v1*` that the E2E asserts is zero.
 */
import { and, desc, eq, inArray } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  appMeta,
  libraryAlbums,
  libraryTracks,
  migrationV1,
  migrationV1Runs,
  type MigrationClass,
  type MigrationRow,
  type MigrationRun,
} from "#/server/db/schema/index.ts";
import { accessSync, constants as fsConstants, mkdirSync } from "node:fs";
import { serverEnv } from "#/server/env.ts";
import { newId } from "#/server/ids.ts";
import { hostPath } from "#/server/paths.ts";
import { emit } from "#/server/services/events.ts";
import { resolvePaths } from "#/server/services/jobs/context.ts";
import { openInboxItem } from "#/server/services/inbox.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import { verifyAlbum } from "#/server/services/verify.ts";
import { toolbox as defaultToolbox, type ToolboxClient } from "#/server/toolbox/client.ts";
import { needsImport, reasonFor } from "./classify.ts";
import {
  createImportGroup,
  migrateAlbum,
  resolveAlbum,
  type ExecuteContext,
  type TrackOutcome,
} from "./execute.ts";
import {
  libraryPrefixOf,
  planFrom,
  probeLibrary,
  type AlbumGrouping,
  type MigrationPlan,
} from "./inventory.ts";
import { defaultPlaylistDir, exportPlaylists } from "./playlists.ts";
import { openV1Reader, redactUrl } from "./reader.ts";
import {
  emptyCounts,
  type MigrationCounts,
  type ReportMove,
  type ReportRegroup,
  type MigrationReport,
  type ReportAlbum,
  type ReportError,
  type ReportImport,
  type ReportRename,
} from "./report.ts";

/* ------------------------------------------------------------------ */
/* the backup acknowledgement (§ Sécurité)                             */
/* ------------------------------------------------------------------ */

/**
 * The one thing this command asks of you before it rewrites your library.
 *
 * It is remembered in `app_meta` rather than in `settings` so that it is not something you can
 * turn on once and forget in a settings page you never revisit — it is an acknowledgement,
 * with a date, that somebody can read afterwards. `--i-have-a-backup` sets it; the Tools card
 * has the same checkbox.
 */
export const BACKUP_KEY = "migration.v1.backup_acknowledged_at";

export async function backupAcknowledged(db: Database = defaultDb()): Promise<string | null> {
  const [row] = await db.select().from(appMeta).where(eq(appMeta.key, BACKUP_KEY)).limit(1);
  return row?.value ?? null;
}

export async function acknowledgeBackup(
  db: Database = defaultDb(),
  at: Date = new Date(),
): Promise<void> {
  await db
    .insert(appMeta)
    .values({ key: BACKUP_KEY, value: at.toISOString(), updatedAt: at })
    .onConflictDoUpdate({
      target: appMeta.key,
      set: { value: at.toISOString(), updatedAt: at },
    });
}

/* ------------------------------------------------------------------ */
/* options                                                             */
/* ------------------------------------------------------------------ */

export interface MigrationOptions {
  /** The v1 Postgres connection string. Never stored unredacted. */
  readonly dbUrl: string;
  /** The v1 library directory, as this process sees it. */
  readonly libraryPath: string;
  readonly dryRun?: boolean;
  readonly renameToTemplate?: boolean;
  /**
   * How an album is decided: `release` (the default) or `tags`.
   *
   * `release` is the rule: one `library_albums` row per v1 release MBID. `tags` reproduces the
   * pre-P11.1 grouping — v1's (album artist, album, year) triple plus the folder — and exists
   * so a library migrated the old way can be reproduced, compared and regrouped on purpose.
   */
  readonly groupBy?: AlbumGrouping;
  /** `--keep-folders`: do not move the minority files into the album's folder. */
  readonly keepFolders?: boolean;
  readonly limit?: number;
  /** Continue the last unfinished run instead of starting a new one. */
  readonly resume?: boolean;
  /** `--i-have-a-backup`. Also settable once, from the Tools card. */
  readonly acknowledgeBackup?: boolean;
  readonly trigger?: string;
  readonly db?: Database;
  readonly toolbox?: ToolboxClient;
  readonly settings?: Settings;
  readonly signal?: AbortSignal;
  /** Read each migrated album back through Navidrome (§ Étapes 6). */
  readonly verify?: boolean;
  /**
   * `documents.build` with the network unplugged. Defaults to fixtures mode (`MM_FIXTURES=1`),
   * never to `true`: in production every release outside the cache must reach MusicBrainz.
   */
  readonly offline?: boolean;
  /** Where the M3U exports go. Defaults to `MM_PLAYLIST_EXPORT_DIR`, else `<library>/.mm-archive/v1-playlists`. */
  readonly playlistDir?: string;
  readonly now?: Date;
  say?(message: string, data?: Record<string, unknown>): Promise<void>;
}

export interface MigrationResult {
  readonly run: MigrationRun;
  readonly report: MigrationReport;
  /** The plan, so a dry run can show what it would have done without re-reading anything. */
  readonly plan: MigrationPlan;
}

/* ------------------------------------------------------------------ */
/* the run                                                             */
/* ------------------------------------------------------------------ */

export async function runMigration(options: MigrationOptions): Promise<MigrationResult> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const toolbox = options.toolbox ?? defaultToolbox();
  const paths = resolvePaths(settings);
  const dryRun = options.dryRun ?? false;
  const now = options.now ?? new Date();
  const started = Date.now();

  const say = async (message: string, data: Record<string, unknown> = {}): Promise<void> => {
    await options.say?.(message, data);
    await emit({ type: "migration.progress", message, data: { ...data, dryRun } }, db);
  };

  /* ---- preflight ---------------------------------------------------- */

  const libraryPrefix = libraryPrefixOf(paths, options.libraryPath);

  // Decided and checked up front: a directory that cannot be written must refuse the run
  // now, not after hours of re-tagging (owner report, 2026-09-08).
  const playlistDir = resolvePlaylistDir(options, hostPath(paths, libraryPrefix));

  if (!dryRun) {
    assertWritableDir(playlistDir, "playlist export directory");
    if (options.acknowledgeBackup === true) await acknowledgeBackup(db, now);
    const acknowledged = await backupAcknowledged(db);
    if (acknowledged === null) {
      throw new MMError(
        "INVALID_INPUT",
        "A migration rewrites the tags of every file in your library. Confirm you have a backup first.",
        {
          hint:
            "Re-run with --i-have-a-backup, or tick the box on Tools › Migrate from v1.\n" +
            "The recommended procedure is to replay this on a copy of the library first " +
            "(v2/docs/migration-v1.md).",
          action: "Take a backup",
        },
      );
    }
  }

  const run = await startRun(db, {
    trigger: options.trigger ?? "cli",
    dryRun,
    renameToTemplate: options.renameToTemplate ?? false,
    libraryPath: options.libraryPath,
    dbLabel: redactUrl(options.dbUrl),
    limit: options.limit ?? null,
    resume: options.resume ?? false,
    now,
  });

  const errors: ReportError[] = [];
  const counts = {
    ...emptyCounts(),
    byClass: { ...emptyCounts().byClass },
    recommendedGaps: {} as Record<string, number>,
  };
  let writes = 0;
  const count = (rows = 1): void => {
    writes += rows;
  };

  try {
    /* ---- inventory ---------------------------------------------------- */

    const groupBy: AlbumGrouping = options.groupBy ?? "release";
    const keepFolders = options.keepFolders ?? false;
    // Where a previous run left each file. Read before the plan, because the reconciliation
    // needs it as its strongest key: a consolidated or renamed file is at a path neither
    // `FinalFilePath` nor v1's own algorithm predicts, and only this table remembers it.
    const knownPaths = await loadKnownPaths(db);

    await say(`reading the v1 database at ${redactUrl(options.dbUrl)}`);
    const reader = openV1Reader({
      url: options.dbUrl,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    let plan: MigrationPlan;
    try {
      const dataset = await reader.read();
      await say(
        `${String(dataset.songs.length)} v1 song(s), ${String(dataset.playlists.length)} playlist(s)`,
        { songs: dataset.songs.length, playlists: dataset.playlists.length },
      );
      const files = await probeLibrary({
        dataset,
        paths,
        libraryPrefix,
        toolbox,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        say,
      });
      await say(`${String(files.length)} audio file(s) under ${options.libraryPath}`);
      plan = planFrom(dataset, files, { groupBy, keepFolders, knownPaths });
    } finally {
      await reader.close();
    }

    counts.songs = plan.songs.length;
    for (const planned of plan.songs) {
      counts.byClass[planned.classification] += 1;
      if (needsImport(planned.classification)) counts.withoutFile += 1;
    }
    counts.orphanFiles = plan.orphans.length;
    counts.withoutRelease = plan.withoutRelease;
    counts.recordings = plan.recordings;
    counts.albumsByRelease = plan.albums.filter((a) => a.groupedBy === "release_mbid").length;
    counts.albumsByTags = plan.albums.filter((a) => a.groupedBy === "tags").length;
    await say(
      `${String(plan.albums.length)} album(s): ${String(counts.albumsByRelease)} by release MBID, ` +
        `${String(counts.albumsByTags)} by v1 tags (${String(plan.withoutRelease)} row(s) have no release)`,
      {
        albums: plan.albums.length,
        byRelease: counts.albumsByRelease,
        byTags: counts.albumsByTags,
      },
    );
    // The other half of "the MBIDs build the track", said out loud for the same reason: a
    // recording recovered from the file is invisible otherwise, and so is one that was lost.
    await say(
      `recording MBIDs: ${String(plan.recordings.forced)} forced, ` +
        `${String(plan.recordings.fromColumn)} from the v1 column, ` +
        `${String(plan.recordings.fromTags)} from MUSICBRAINZ_TRACKID in the file, ` +
        `${String(plan.recordings.none)} with none`,
      { recordings: plan.recordings },
    );

    /* ---- what a previous run already finished -------------------------- */

    const stateBySong = await loadState(
      db,
      plan.songs.map((planned) => planned.song.id),
    );

    /* ---- execute ------------------------------------------------------- */

    const albums: ReportAlbum[] = [];
    const created: ReportImport[] = [];
    const renames: ReportRename[] = [];
    const moves: ReportMove[] = [];
    const regroup: ReportRegroup[] = [];
    const filesBySong = new Map<number, string>();

    const ctx: ExecuteContext = {
      db,
      toolbox,
      settings,
      paths,
      runId: run.id,
      renameToTemplate: options.renameToTemplate ?? false,
      keepFolders,
      offline: options.offline ?? serverEnv().MM_FIXTURES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      now,
      say,
      count,
    };

    /* ---- the regrouping, which is why a second run is not always a no-op --- */
    //
    // A library migrated before the release-MBID rule — or with `--group-by tags` — holds one
    // `library_albums` row per (album artist, album, year, folder). Re-running puts every track
    // in the row of its release instead, and that is a *move* between existing rows, not a new
    // migration: the tracks are already done by `migration_v1`'s reckoning, so nothing below
    // would touch them without this pass saying so.
    //
    // It is computed before anything is written, so the dry run prints exactly what the real
    // run will do.
    const previousAlbumIds = new Set(
      [...stateBySong.values()]
        .map((state) => state.libraryAlbumId)
        .filter((id): id is string => id !== null),
    );
    const albumLabels = await loadAlbumLabels(db, [...previousAlbumIds]);
    const targets = new Map<string, string | null>();
    const mustRegroup = new Set<string>();

    for (const album of plan.albums) {
      const resolved = await resolveAlbum(db, album);
      targets.set(album.key, resolved.id);

      const from = new Map<string, number>();
      for (const planned of album.tracks) {
        const held = stateBySong.get(planned.song.id)?.libraryAlbumId ?? null;
        if (held === null || held === resolved.id) continue;
        from.set(held, (from.get(held) ?? 0) + 1);
      }
      if (from.size === 0 && album.moves.length === 0) continue;

      mustRegroup.add(album.key);
      counts.regrouped += [...from.values()].reduce((sum, value) => sum + value, 0);
      regroup.push({
        release: album.releaseMbid,
        album: `${album.artist} — ${album.title}`,
        from: [...from.keys()].map((id) => albumLabels.get(id) ?? id),
        to: resolved.folder,
        tracks: album.tracks.length,
        moves: album.moves.map((move) => ({ from: move.from, to: move.to })),
      });
      await say(
        `regrouping ${album.artist} — ${album.title}: ` +
          `${String([...from.values()].reduce((sum, value) => sum + value, 0))} track(s) from ` +
          `${String(from.size)} other album row(s), ${String(album.moves.length)} file move(s)`,
        { album: album.key, release: album.releaseMbid, to: resolved.folder },
      );
    }

    /*
     * One import per album, even when two albums used to share one.
     *
     * `previousImport` below reuses whatever import a track's row remembers. Before the
     * regrouping that was always the album's own; after it, two plan albums can both point at
     * the import the single pre-regrouping album had. They would then overwrite each other's
     * `import_tracks` by position and prune each other's rows, so the second claimant gets a
     * fresh import instead.
     */
    const claimedImports = new Set<string>();

    for (const album of plan.albums) {
      options.signal?.throwIfAborted();

      const pending = album.tracks.filter(
        (planned) => !isDone(stateBySong.get(planned.song.id), planned.file?.path ?? null),
      );
      // Not "already done" when the album is being regrouped: those tracks are about to be
      // migrated again, and counting them in both columns would make the report add up to more
      // rows than v1 has.
      if (!mustRegroup.has(album.key)) counts.alreadyDone += album.tracks.length - pending.length;

      if (dryRun) {
        albums.push(dryAlbum(album));
        // The preview must list the moves too: a dry run is the only chance to see them before
        // the play counts follow the files.
        for (const move of album.moves) moves.push({ from: move.from, to: move.to });
        counts.consolidated += album.moves.length;
        for (const planned of album.tracks) {
          if (planned.file !== null) filesBySong.set(planned.song.id, planned.file.path);
        }
        await recordRows(db, run.id, album.tracks, { outcome: "planned" });
        continue;
      }

      // An album whose tracks are all done is skipped — unless the regrouping pass found it
      // sitting in the wrong `library_albums` row, or found files to consolidate. That is what
      // makes a re-run over an already migrated library regroup it instead of doing nothing.
      if (pending.length === 0 && !mustRegroup.has(album.key)) {
        albums.push({ ...dryAlbum(album), verified: "skipped" });
        for (const planned of album.tracks) {
          const state = stateBySong.get(planned.song.id);
          if (state?.path != null) filesBySong.set(planned.song.id, state.path);
        }
        continue;
      }

      const previousImport = album.tracks
        .map((planned) => stateBySong.get(planned.song.id)?.importId ?? null)
        .find((value): value is string => value !== null && !claimedImports.has(value));
      if (previousImport !== undefined) claimedImports.add(previousImport);

      const outcome = await migrateAlbum(ctx, album, { importId: previousImport ?? null });

      counts.migrated += outcome.tracks.length;
      counts.documentsComplete += outcome.tracks.filter((track) => track.complete).length;
      for (const track of outcome.tracks) {
        for (const gap of track.recommendedGaps) {
          counts.recommendedGaps[gap] = (counts.recommendedGaps[gap] ?? 0) + 1;
        }
      }
      counts.filesRetagged += outcome.tracks.filter((track) => track.retagged).length;
      counts.sidecarsWritten += outcome.tracks.reduce((sum, track) => sum + track.sidecars, 0);
      counts.renamed += outcome.tracks.filter((track) => track.renamedFrom !== null).length;
      counts.consolidated += outcome.moves.length;
      if (outcome.replaygain) counts.replaygainAlbums += 1;
      counts.failed += outcome.failures.length;

      for (const track of outcome.tracks) {
        filesBySong.set(track.songId, track.path);
        if (track.renamedFrom !== null) {
          renames.push({ from: track.renamedFrom, to: track.path });
        }
        if (track.movedFrom !== null) {
          moves.push({ from: track.movedFrom, to: track.path });
        }
      }
      for (const failure of outcome.failures) errors.push(failure);

      await recordTrackRows(db, run.id, album, outcome.tracks, outcome.albumId);
      await recordFailures(db, run.id, album.tracks, outcome.failures);

      const first = outcome.tracks[0];
      albums.push({
        id: outcome.albumId,
        folder: outcome.folder,
        // What the rebuilt documents say, which is the release's own name — not the v1 tags
        // the plan was seeded with.
        artist: first?.album.artist ?? album.artist,
        title: first?.album.title ?? album.title,
        year: first?.album.year ?? album.year,
        tracks: outcome.tracks.length,
        completeness: meanCompleteness(outcome.tracks),
        replaygain: outcome.replaygain,
        verified: "skipped",
      });
    }

    /* ---- the album rows the regrouping emptied -------------------------- */
    //
    // Only rows a track of this migration used to be in, and only when nothing is left in them.
    // Deleting every empty `library_albums` row would reach outside the migration, into albums
    // somebody imported normally and is in the middle of repairing.
    if (!dryRun && previousAlbumIds.size > 0) {
      for (const albumId of previousAlbumIds) {
        options.signal?.throwIfAborted();
        const remaining = await db
          .select({ id: libraryTracks.id })
          .from(libraryTracks)
          .where(eq(libraryTracks.albumId, albumId))
          .limit(1);
        if (remaining.length > 0) continue;
        await db.delete(libraryAlbums).where(eq(libraryAlbums.id, albumId));
        count();
        counts.albumsRemoved += 1;
        await say(
          `removed the album row left empty by the regrouping: ${albumLabels.get(albumId) ?? albumId}`,
          {
            album: albumId,
          },
        );
      }
    }

    /* ---- the rows with no file ---------------------------------------- */

    for (const group of plan.importGroups) {
      options.signal?.throwIfAborted();

      const pending = group.songs.filter(
        (planned) => !isDone(stateBySong.get(planned.song.id), null),
      );
      counts.alreadyDone += group.songs.length - pending.length;

      if (dryRun) {
        created.push({
          importId: "(dry run)",
          playlist: group.playlist,
          url: group.url,
          status: group.songs.some((item) => item.classification === "needs_manual_review")
            ? "awaiting_review"
            : "paused",
          tracks: group.songs.length,
          preselected: group.songs.filter(
            (item) => item.song.musicBrainzRecordingId !== null || item.song.musicBrainzForced,
          ).length,
        });
        await recordRows(db, run.id, group.songs, { outcome: "planned" });
        continue;
      }

      if (pending.length === 0) continue;

      const previousImport = group.songs
        .map((planned) => stateBySong.get(planned.song.id)?.importId ?? null)
        .find((value): value is string => value !== null);

      const outcome = await createImportGroup(ctx, group, { importId: previousImport ?? null });
      counts.importsCreated += 1;
      counts.importTracksCreated += outcome.tracks.length;
      counts.inboxItems += outcome.inboxItems;

      created.push({
        importId: outcome.importId,
        playlist: outcome.playlist,
        url: outcome.url,
        status: outcome.status,
        tracks: outcome.tracks.length,
        preselected: outcome.tracks.filter((track) => track.preselected).length,
      });

      await recordImportRows(db, run.id, group.songs, outcome);
    }

    /* ---- playlists (§ Étapes 5) ---------------------------------------- */

    const exported = exportPlaylists(
      {
        playlists: plan.dataset.playlists,
        links: plan.dataset.playlistSongs,
        songs: new Map(plan.dataset.songs.map((song) => [song.id, song])),
        files: filesBySong,
        libraryRoot: hostPath(paths, ""),
        targetDir: playlistDir,
      },
      { dryRun },
    );
    if (exported.length > 0) {
      await say(`${String(exported.length)} playlist(s) exported to ${playlistDir}`);
    }

    /* ---- verify (§ Étapes 6) ------------------------------------------- */

    const verified = await verifyAlbums(db, settings, albums, {
      enabled: (options.verify ?? false) && !dryRun && settings.navidromeEnabled,
      say,
    });
    counts.albumsVerified = verified.filter((album) => album.verified === "ok").length;

    /* ---- the gaps, as Inbox items -------------------------------------- */

    if (!dryRun) {
      counts.inboxItems += await openGapItems(db, {
        orphans: plan.orphans.map((file) => file.path),
        discrepancies: plan.reconciliation.discrepancies.length,
        libraryPath: options.libraryPath,
      });
    }

    /* ---- report --------------------------------------------------------- */

    const report: MigrationReport = {
      runId: run.id,
      dryRun,
      renameToTemplate: options.renameToTemplate ?? false,
      groupBy,
      keepFolders,
      library: options.libraryPath,
      database: redactUrl(options.dbUrl),
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      counts,
      albums: verified,
      imports: created,
      playlists: exported.map((playlist) => ({
        name: playlist.name,
        path: playlist.path,
        entries: playlist.entries,
        missing: playlist.missing,
      })),
      renames,
      moves,
      regroup,
      discrepancies: plan.reconciliation.discrepancies,
      errors,
      writes,
    };

    const finished = await finishRun(db, run.id, {
      status: "done",
      counts,
      writes,
      durationMs: report.durationMs,
      report,
      message: summarise(counts, dryRun),
    });

    return { run: finished, report, plan };
  } catch (error) {
    const failure = MMError.from(error);
    await failRun(db, run.id, failure, Date.now() - started);
    throw failure;
  }
}

/* ------------------------------------------------------------------ */
/* the run row                                                         */
/* ------------------------------------------------------------------ */

interface StartRunInput {
  readonly trigger: string;
  readonly dryRun: boolean;
  readonly renameToTemplate: boolean;
  readonly libraryPath: string;
  readonly dbLabel: string;
  readonly limit: number | null;
  readonly resume: boolean;
  readonly now: Date;
}

async function startRun(db: Database, input: StartRunInput): Promise<MigrationRun> {
  if (input.resume) {
    const [unfinished] = await db
      .select()
      .from(migrationV1Runs)
      .where(eq(migrationV1Runs.status, "running"))
      .orderBy(desc(migrationV1Runs.createdAt))
      .limit(1);
    if (unfinished !== undefined) return unfinished;
  }

  const [created] = await db
    .insert(migrationV1Runs)
    .values({
      id: newId("migrationRun", input.now.getTime()),
      trigger: input.trigger,
      status: "running",
      dryRun: input.dryRun,
      renameToTemplate: input.renameToTemplate,
      libraryPath: input.libraryPath,
      dbLabel: input.dbLabel,
      limit: input.limit,
      startedAt: input.now,
    })
    .returning();
  if (created === undefined) throw new MMError("UNKNOWN", "Could not create the migration run.");
  return created;
}

async function finishRun(
  db: Database,
  runId: string,
  input: {
    status: string;
    counts: MigrationCounts;
    writes: number;
    durationMs: number;
    report: MigrationReport;
    message: string;
  },
): Promise<MigrationRun> {
  const [updated] = await db
    .update(migrationV1Runs)
    .set({
      status: input.status,
      total: input.counts.songs,
      done: input.counts.songs,
      migrated: input.counts.migrated,
      importsCreated: input.counts.importsCreated,
      orphanFiles: input.counts.orphanFiles,
      failed: input.counts.failed,
      writes: input.writes,
      durationMs: input.durationMs,
      message: input.message,
      report: input.report as unknown as Record<string, unknown>,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(migrationV1Runs.id, runId))
    .returning();
  if (updated === undefined) throw new MMError("UNKNOWN", `Migration run ${runId} vanished.`);
  return updated;
}

async function failRun(
  db: Database,
  runId: string,
  error: MMError,
  durationMs: number,
): Promise<void> {
  await db
    .update(migrationV1Runs)
    .set({
      status: "failed",
      durationMs,
      message: error.message,
      error: { code: error.code, message: error.message },
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(migrationV1Runs.id, runId));
}

/* ------------------------------------------------------------------ */
/* per-song state — what makes a second run a no-op                    */
/* ------------------------------------------------------------------ */

async function loadState(
  db: Database,
  songIds: readonly number[],
): Promise<Map<number, MigrationRow>> {
  if (songIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(migrationV1)
    .where(
      inArray(
        migrationV1.v1SongId,
        songIds.map((id) => String(id)),
      ),
    );
  return new Map(rows.map((row) => [Number(row.v1SongId), row]));
}

/**
 * Has this row already been done, at this path?
 *
 * The path is half the key on purpose (§ Commande). A row marked `migrated` whose file has
 * since moved is *not* done: re-tagging the old path would touch a file that is no longer
 * there, and skipping it would leave the new one untagged.
 */
function isDone(state: MigrationRow | undefined, path: string | null): boolean {
  if (state === undefined) return false;
  if (state.outcome === "migrated") return path !== null && state.path === path;
  if (state.outcome === "import_created") return true;
  return false;
}

async function upsertRow(
  db: Database,
  values: {
    runId: string;
    v1SongId: string;
    v1Path: string | null;
    path: string | null;
    classification: MigrationClass;
    outcome: MigrationRow["outcome"];
    matchedBy: MigrationRow["matchedBy"];
    libraryAlbumId?: string | null;
    libraryTrackId?: string | null;
    documentId?: string | null;
    importId?: string | null;
    importTrackId?: string | null;
    renamedFrom?: string | null;
    detail?: Record<string, unknown>;
    error?: { code: string; message: string } | null;
  },
  options: { onlyIfPlanned?: boolean } = {},
): Promise<void> {
  await db
    .insert(migrationV1)
    .values({ id: newId("migrationRow"), ...values })
    .onConflictDoUpdate({
      target: migrationV1.v1SongId,
      set: { ...values, updatedAt: new Date() },
      ...(options.onlyIfPlanned === true ? { setWhere: eq(migrationV1.outcome, "planned") } : {}),
    });
}

async function recordRows(
  db: Database,
  runId: string,
  songs: readonly {
    song: { id: number; finalFilePath: string | null };
    classification: MigrationClass;
    file: { path: string } | null;
    matchedBy: MigrationRow["matchedBy"];
  }[],
  options: { outcome: MigrationRow["outcome"] },
): Promise<void> {
  for (const planned of songs) {
    await upsertRow(
      db,
      {
        runId,
        v1SongId: String(planned.song.id),
        v1Path: planned.song.finalFilePath,
        path: planned.file?.path ?? null,
        classification: planned.classification,
        outcome: options.outcome,
        matchedBy: planned.matchedBy,
      },
      /*
       * A dry run never downgrades a finished row.
       *
       * `planned` is the outcome this writes, and it is the only one a dry run produces. Left
       * to overwrite, it would take a library that is already migrated and mark all of it
       * `planned` again: the next real run would then re-migrate everything instead of
       * recognising it as done, and — worse — `loadKnownPaths` would lose the paths this
       * application itself wrote when it consolidated or renamed a file. That matters because
       * "dry run, then real run" is the documented way to regroup a migrated library
       * (`docs/migration-v1.md`), so the preview must be free.
       */
      { onlyIfPlanned: options.outcome === "planned" },
    );
  }
}

async function recordTrackRows(
  db: Database,
  runId: string,
  album: MigrationPlan["albums"][number],
  outcomes: readonly TrackOutcome[],
  albumId: string,
): Promise<void> {
  const plannedBySong = new Map(album.tracks.map((planned) => [planned.song.id, planned]));
  for (const outcome of outcomes) {
    const planned = plannedBySong.get(outcome.songId);
    if (planned === undefined) continue;
    await upsertRow(db, {
      runId,
      v1SongId: String(outcome.songId),
      v1Path: planned.song.finalFilePath,
      path: outcome.path,
      classification: planned.classification,
      outcome: "migrated",
      matchedBy: planned.matchedBy,
      libraryAlbumId: albumId,
      libraryTrackId: outcome.libraryTrackId,
      documentId: outcome.documentId,
      importId: outcome.importId,
      importTrackId: outcome.importTrackId,
      renamedFrom: outcome.renamedFrom,
      detail: {
        title: planned.song.title,
        completeness: outcome.completeness,
        complete: outcome.complete,
        lockedFields: outcome.locked,
      },
      error: null,
    });
  }
}

async function recordImportRows(
  db: Database,
  runId: string,
  songs: MigrationPlan["importGroups"][number]["songs"],
  outcome: { importId: string; tracks: readonly { songId: number; importTrackId: string }[] },
): Promise<void> {
  const trackBySong = new Map(outcome.tracks.map((track) => [track.songId, track.importTrackId]));
  for (const planned of songs) {
    await upsertRow(db, {
      runId,
      v1SongId: String(planned.song.id),
      v1Path: planned.song.finalFilePath,
      path: null,
      classification: planned.classification,
      outcome: "import_created",
      matchedBy: "none",
      importId: outcome.importId,
      importTrackId: trackBySong.get(planned.song.id) ?? null,
      detail: {
        title: planned.song.title ?? planned.song.sourceTitle,
        url: planned.song.sourceUrl,
        reason: reasonFor(planned.song, planned.classification),
      },
      error: null,
    });
  }
}

async function recordFailures(
  db: Database,
  runId: string,
  songs: MigrationPlan["albums"][number]["tracks"],
  failures: readonly { songId: number; path: string | null; message: string }[],
): Promise<void> {
  const plannedBySong = new Map(songs.map((planned) => [planned.song.id, planned]));
  for (const failure of failures) {
    const planned = plannedBySong.get(failure.songId);
    if (planned === undefined) continue;
    await upsertRow(db, {
      runId,
      v1SongId: String(failure.songId),
      v1Path: planned.song.finalFilePath,
      path: failure.path,
      classification: planned.classification,
      outcome: "failed",
      matchedBy: planned.matchedBy,
      error: { code: "UNKNOWN", message: failure.message },
    });
  }
}

/* ------------------------------------------------------------------ */
/* the tail of the run                                                 */
/* ------------------------------------------------------------------ */

async function verifyAlbums(
  db: Database,
  settings: Settings,
  albums: readonly ReportAlbum[],
  options: {
    enabled: boolean;
    say: (message: string, data?: Record<string, unknown>) => Promise<void>;
  },
): Promise<ReportAlbum[]> {
  if (!options.enabled) return [...albums];

  const out: ReportAlbum[] = [];
  for (const album of albums) {
    try {
      const verification = await verifyAlbum(album.id, { db, settings });
      out.push({
        ...album,
        verified:
          verification.note !== null
            ? "not_indexed"
            : verification.requiredMismatches.length === 0
              ? "ok"
              : "mismatch",
      });
      await options.say(`verified ${album.folder}`, { album: album.id });
    } catch (error) {
      await options.say(`verify failed for ${album.folder}: ${MMError.from(error).message}`);
      out.push({ ...album, verified: "skipped" });
    }
  }
  return out;
}

/**
 * The two Inbox items a migration can raise (§ Étapes 6).
 *
 * Both are collective rather than per-file: twenty thousand orphan files is one question
 * ("what do you want to do with the rest of this directory?"), not twenty thousand.
 */
async function openGapItems(
  db: Database,
  input: { orphans: readonly string[]; discrepancies: number; libraryPath: string },
): Promise<number> {
  let opened = 0;

  if (input.orphans.length > 0) {
    await openInboxItem(
      {
        type: "orphan_files",
        title: `${String(input.orphans.length)} file(s) in the v1 library that no v1 row claims`,
        summary:
          "They were found under the migrated library but no `Songs` row matches them by path, " +
          "recording MBID or YouTube id.",
        payload: {
          source: "migration-v1",
          library: input.libraryPath,
          paths: input.orphans.slice(0, 200),
          total: input.orphans.length,
        },
      },
      db,
    );
    opened += 1;
  }

  return opened;
}

function meanCompleteness(tracks: readonly TrackOutcome[]): number | null {
  const scores = tracks
    .map((track) => track.completeness)
    .filter((score): score is number => score !== null);
  if (scores.length === 0) return null;
  return scores.reduce((sum, value) => sum + value, 0) / scores.length;
}

function dryAlbum(album: MigrationPlan["albums"][number]): ReportAlbum {
  return {
    id: "(dry run)",
    folder: album.folder,
    artist: album.artist,
    title: album.title,
    year: album.year,
    tracks: album.tracks.length,
    completeness: null,
    replaygain: false,
    verified: "skipped",
  };
}

function summarise(counts: MigrationCounts, dryRun: boolean): string {
  return (
    `${dryRun ? "would migrate" : "migrated"} ${String(counts.migrated)} track(s), ` +
    `${String(counts.importsCreated)} import(s), ${String(counts.orphanFiles)} orphan file(s), ` +
    `${String(counts.failed)} failure(s)`
  );
}

/* ------------------------------------------------------------------ */
/* reading a run back                                                  */
/* ------------------------------------------------------------------ */

export async function getRun(id: string, db: Database = defaultDb()): Promise<MigrationRun | null> {
  const [row] = await db.select().from(migrationV1Runs).where(eq(migrationV1Runs.id, id)).limit(1);
  return row ?? null;
}

export async function lastRun(
  db: Database = defaultDb(),
  options: { dryRun?: boolean } = {},
): Promise<MigrationRun | null> {
  const rows = await db
    .select()
    .from(migrationV1Runs)
    .where(
      options.dryRun === undefined ? undefined : and(eq(migrationV1Runs.dryRun, options.dryRun)),
    )
    .orderBy(desc(migrationV1Runs.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

export async function listRuns(
  limit = 10,
  db: Database = defaultDb(),
): Promise<readonly MigrationRun[]> {
  return await db
    .select()
    .from(migrationV1Runs)
    .orderBy(desc(migrationV1Runs.createdAt))
    .limit(limit);
}

export function reportOf(run: MigrationRun): MigrationReport | null {
  return run.report === null ? null : (run.report as unknown as MigrationReport);
}

/** `playlistDir` option, else `MM_PLAYLIST_EXPORT_DIR`, else `<library>/.mm-archive/v1-playlists`. */
function resolvePlaylistDir(options: MigrationOptions, libraryRoot: string): string {
  if (options.playlistDir !== undefined && options.playlistDir !== "") return options.playlistDir;
  const fromEnv = serverEnv().MM_PLAYLIST_EXPORT_DIR;
  return fromEnv === "" ? defaultPlaylistDir(libraryRoot) : fromEnv;
}

/** Create the directory if needed and prove it is writable, or refuse with the path named. */
function assertWritableDir(dir: string, what: string): void {
  try {
    mkdirSync(dir, { recursive: true });
    accessSync(dir, fsConstants.W_OK);
  } catch (error) {
    throw new MMError("INVALID_INPUT", `The ${what} is not writable: ${dir}`, {
      hint:
        "Set MM_PLAYLIST_EXPORT_DIR to a directory this process can write, or leave it empty " +
        "to use <library>/.mm-archive/v1-playlists.",
      action: "Fix the directory",
      details: { dir, cause: error instanceof Error ? error.message : String(error) },
    });
  }
}

/**
 * Where a previous run left every v1 row's file, by v1 song id.
 *
 * Read from `migration_v1` for the whole table rather than for the rows of this plan: it is one
 * query either way, and the plan is not built yet when this is needed — the reconciliation is
 * what consumes it.
 *
 * **Only `migrated` rows.** The path on a `planned` row is not new information — it is where the
 * *inventory* found the file, which the reconciliation is about to work out again by itself —
 * and a dry run writes one for every row. Trusting those made the ordinary "dry run, then real
 * run" sequence hand the reconciliation the answer: every file then matched by path, the two
 * that had really been moved stopped being reported as `path_moved`, and `matched_by` said
 * `path` for the whole library. A `migrated` row is different in kind: it records a path *this
 * application wrote*, after a consolidation or a `--rename-to-template`, and nothing else in
 * the world remembers it.
 */
async function loadKnownPaths(db: Database): Promise<Map<number, string>> {
  const rows = await db
    .select({ songId: migrationV1.v1SongId, path: migrationV1.path })
    .from(migrationV1)
    .where(eq(migrationV1.outcome, "migrated"));
  const out = new Map<number, string>();
  for (const row of rows) {
    if (row.path === null || row.path === "") continue;
    const id = Number(row.songId);
    if (Number.isFinite(id)) out.set(id, row.path);
  }
  return out;
}

/** `Artist — Title (folder)` for each album row, so the regrouping plan reads like prose. */
async function loadAlbumLabels(db: Database, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({
      id: libraryAlbums.id,
      title: libraryAlbums.title,
      artist: libraryAlbums.albumArtist,
      folder: libraryAlbums.folder,
    })
    .from(libraryAlbums)
    .where(inArray(libraryAlbums.id, [...ids]));
  return new Map(rows.map((row) => [row.id, `${row.artist} — ${row.title} (${row.folder})`]));
}
