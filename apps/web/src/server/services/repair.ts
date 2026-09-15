/**
 * `repair.service` — putting back a `library_tracks` row whose file is still on disk.
 *
 * The scan already *names* this state: an **orphan** is a file the database has never heard
 * of, and `runScan` counts them, lists them in its report and raises an Inbox item about them.
 * What it offers to do with one is identify it by fingerprint or move it to the trash, and
 * neither is the answer when the file is one this installation wrote itself and then lost the
 * row for. This module is that third answer.
 *
 * It is the net under the v1 migration rather than its main remedy, and the difference matters.
 * A migration that died halfway leaves thousands of files with no row, and the right fix for
 * those is to **run the migration again**: `migration_v1` remembers what is done, so a second
 * pass finishes the rest with all of v1's own knowledge — the forced MBIDs, the playlists, the
 * provenance. What is left after that is what v1 never knew about: a file copied in by hand, a
 * `Songs` row deleted since, a track whose album could not be built. Those have nothing but
 * their own tags, and this is what reads them.
 *
 * The evidence it works from is the file's own tags, which is the whole point. Every file this
 * project or its predecessor ever wrote carries `MUSICBRAINZ_ALBUMID` and `MUSICBRAINZ_TRACKID`
 * — Picard's names for the release and the recording — so an orphan says which album it
 * belongs to without a network call, a fingerprint or a guess. Three rungs, in order:
 *
 *  1. **the row that is already there** — an album row of the file's release holding a track
 *     with the same recording MBID whose own file is gone. That is not a new track, it is a
 *     row that lost track of its file, and the repair is to point it back at the file rather
 *     than to insert a second row;
 *  2. **the album of the release** (`library_albums.release_mbid`), preferring the row whose
 *     folder is the file's own;
 *  3. **the album of the folder** (`library_albums.folder`), for a file whose release nothing
 *     knows; and failing that, a new album row built from the file's `ALBUM`/`ALBUMARTIST`.
 *
 * The document is rebuilt from the tags at source `app`, which sits *below* every network
 * source in `SOURCE_PRECEDENCE` — so a later `documents.rebuild` replaces every one of these
 * values with the real thing rather than being blocked by them. And when the file still
 * carries its `Source:` comment, the import behind it is recreated too, because a library
 * track with no import is one `retag` refuses to rebuild.
 *
 * Nothing is deleted, ever, and `dryRun` is the default from the CLI: the repair prints what
 * it would attach, to which album, under which title, and only does it when asked twice.
 */
import { and, eq, isNotNull, or, sql } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import {
  emptyDocument,
  field,
  projectDocument,
  tagsByVorbisKey,
  TAG_SCHEMA_VERSION,
  trackCompleteness,
  type Field,
  type FieldValue,
  type TrackDocument,
} from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  imports,
  importTracks,
  libraryAlbums,
  libraryTracks,
  metadataDocuments,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { containerPath, type PathMap } from "#/server/paths.ts";
import { toolbox as defaultToolbox, type ToolboxClient } from "#/server/toolbox/client.ts";
import { recountAlbums } from "#/server/services/album-counters.ts";
import { emit } from "#/server/services/events.ts";
import { resolvePaths } from "#/server/services/jobs/context.ts";
import { discBucket, freeAlbumPosition, insertLibraryTrack } from "#/server/services/positions.ts";
import { hashProjection, formatOf } from "#/server/services/retag.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import { walkLibrary, type WalkedFile } from "#/server/services/scan.ts";

/**
 * What the repair did with one orphan file, and why.
 *
 * Four outcomes, and the difference between the last two is the difference between "this file
 * is not something I can put back" and "I tried and the database refused me":
 *
 * - `reattached` — an existing row was pointed back at the file;
 * - `created` — a new row (and possibly a new album row) was written for it;
 * - `skipped` — nothing was attempted, and `reason` says why (an unreadable file, typically);
 * - `failed` — the write was attempted and refused, and `reason` is the refusal.
 *
 * A `failed` file is recorded and the walk goes on. One file used to take the whole command
 * down with it: nine orphans, three attached, an insert refused on the fourth, and the last
 * five never looked at.
 */
export interface RepairedOrphan {
  readonly path: string;
  readonly outcome: "reattached" | "created" | "skipped" | "failed";
  readonly title: string;
  /** The album row the file was attached to, and how it was found. */
  readonly albumId: string | null;
  readonly album: string | null;
  readonly albumFoundBy: "recording" | "release" | "folder" | "new" | null;
  readonly trackId: string | null;
  readonly discNumber: number | null;
  readonly trackNumber: number | null;
  readonly recordingMbid: string | null;
  readonly releaseMbid: string | null;
  /** True when the file's `Source:` comment let the import behind it be recreated. */
  readonly provenance: boolean;
  /** Why a `skipped` file was skipped, or why a `failed` one failed. */
  readonly reason: string | null;
}

export interface RepairReport {
  readonly at: string;
  readonly root: string;
  readonly dryRun: boolean;
  readonly filesSeen: number;
  readonly orphans: number;
  readonly reattached: number;
  readonly created: number;
  readonly skipped: number;
  /** Files the repair tried to write and could not. `items` carries the reason for each. */
  readonly failed: number;
  readonly albumsCreated: number;
  readonly items: readonly RepairedOrphan[];
  readonly notes: readonly string[];
}

export interface RepairOptions {
  readonly db?: Database;
  readonly settings?: Settings;
  readonly toolbox?: ToolboxClient;
  readonly paths?: PathMap;
  /** Preview only. **The default**, because this writes rows a person has to live with. */
  readonly dryRun?: boolean;
  /** Cap on the number of orphans examined, so a mis-pointed library root is cheap. */
  readonly limit?: number;
  readonly signal?: AbortSignal;
  readonly say?: (message: string) => Promise<void>;
}

/* ------------------------------------------------------------------ */
/* reading a file's own tags                                           */
/* ------------------------------------------------------------------ */

/** Tags as `/probe` reports them, upper-cased, so a lookup does not depend on the muxer. */
function upperKeys(tags: Readonly<Record<string, unknown>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tags)) {
    if (value === null || value === undefined) continue;
    const text = Array.isArray(value) ? value.map(String).join("; ") : String(value);
    if (text.trim() !== "") out.set(key.toUpperCase(), text);
  }
  return out;
}

/**
 * ffmpeg's own spellings, the three that matter here.
 *
 * The same list `compareTags` carries in `scan.ts`, and for the same reason: a repaired track
 * that lost its position because ffprobe calls `TRACKNUMBER` `TRACK` would be a repair that
 * made things worse.
 */
const FFPROBE_ALIASES: Readonly<Record<string, string>> = {
  ALBUMARTIST: "ALBUM_ARTIST",
  TRACKNUMBER: "TRACK",
  DISCNUMBER: "DISC",
};

function tagValue(tags: ReadonlyMap<string, string>, key: string): string | null {
  const direct = tags.get(key);
  if (direct !== undefined) return direct;
  const alias = FFPROBE_ALIASES[key];
  return alias === undefined ? null : (tags.get(alias) ?? null);
}

function tagNumber(tags: ReadonlyMap<string, string>, key: string): number | null {
  const raw = tagValue(tags, key);
  if (raw === null) return null;
  // `04/13` is a legal `TRACKNUMBER`; the part before the slash is the position.
  const parsed = Number.parseInt(raw.split("/")[0]?.trim() ?? "", 10);
  return Number.isFinite(parsed) ? parsed : null;
}

/** The YouTube URL v1 and v2 both wrote into `COMMENT` as `Source: <url>`. */
function sourceUrlOf(tags: ReadonlyMap<string, string>): string | null {
  for (const key of ["MUSICMANAGER_SOURCEURL", "COMMENT", "DESCRIPTION"]) {
    const value = tags.get(key);
    if (value === undefined) continue;
    const url = /^\s*Source:\s*(\S+)/i.exec(value)?.[1] ?? value.trim();
    if (/^https?:\/\//i.test(url)) return url;
  }
  return null;
}

/** The fields a probe's tag dictionary cannot carry in a form a document could use. */
const UNREADABLE_FROM_A_PROBE = new Set([
  "lyrics",
  "lyrics_synced",
  "front_cover",
  "back_cover",
  "acoustid_fingerprint",
]);

/**
 * A `TrackDocument` built from nothing but the file.
 *
 * The tag map is read backwards — `tagsByVorbisKey` turns `ALBUMARTIST` back into
 * `albumartist` — so the document speaks the same vocabulary as one the pipeline produced and
 * `projectDocument` round-trips it. Multi-valued fields are split on `;`, which is how both
 * mutagen and ffprobe fold repeated Vorbis comments, and nothing else is inferred: a key the
 * tag map does not know is not a field, it is somebody's tag, and it is left in the file.
 */
export function documentFromTags(tags: ReadonlyMap<string, string>, now: Date): TrackDocument {
  const fetchedAt = now.toISOString();
  const fields: Record<string, Field> = {};

  for (const [key, raw] of tags) {
    const canonical =
      tagsByVorbisKey(key)[0] ??
      tagsByVorbisKey(
        Object.entries(FFPROBE_ALIASES).find(([, alias]) => alias === key)?.[0] ?? "",
      )[0];
    if (canonical === undefined) continue;
    // Pictures and lyrics do not survive an ffprobe tag dictionary in a usable form — the
    // picture blocks are binary and ffprobe truncates megabytes of LRC — and a document
    // claiming a cover it cannot produce is worse than one admitting it has none. The picture
    // stays in the file regardless: `/tag` re-attaches what it finds when none is supplied.
    if (UNREADABLE_FROM_A_PROBE.has(canonical.field)) continue;

    let value: FieldValue;
    if (canonical.multi) {
      const parts = raw
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part !== "");
      if (parts.length === 0) continue;
      value = parts;
    } else if (
      ["tracknumber", "totaltracks", "discnumber", "totaldiscs"].includes(canonical.field)
    ) {
      const parsed = Number.parseInt(raw.split("/")[0]?.trim() ?? "", 10);
      if (!Number.isFinite(parsed)) continue;
      value = parsed;
    } else {
      value = raw;
    }

    fields[canonical.field] = field(value, "app", fetchedAt, {
      confidence: 0.3,
      note: "read back from the file during `mm library repair-orphans`",
    });
  }

  return { ...emptyDocument(TAG_SCHEMA_VERSION), fields };
}

/* ------------------------------------------------------------------ */
/* the repair                                                          */
/* ------------------------------------------------------------------ */

interface AlbumChoice {
  readonly id: string;
  readonly title: string;
  readonly foundBy: "release" | "folder" | "new";
  readonly created: boolean;
}

function folderOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? "" : path.slice(0, index);
}

/**
 * Walk the library, find the audio files no `library_tracks` row claims, and put them back.
 *
 * Returns what it did (or would do) per file. Writes nothing when `dryRun`, which is what the
 * CLI passes unless `--apply` is given.
 */
export async function repairOrphans(options: RepairOptions = {}): Promise<RepairReport> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const paths = options.paths ?? resolvePaths(settings);
  const box = options.toolbox ?? defaultToolbox();
  const say = options.say ?? (async () => {});
  const dryRun = options.dryRun ?? true;
  const now = new Date();

  const root = paths.host;
  await say(`Walking ${root}.`);
  const files = walkLibrary(root);

  const onDisk = new Set(files.map((file) => file.path));
  const tracked = new Set(
    (await db.select({ path: libraryTracks.path }).from(libraryTracks)).map((row) => row.path),
  );
  const orphans = files.filter((file) => !tracked.has(file.path)).slice(0, options.limit ?? 5_000);
  await say(
    `${String(files.length)} file(s), ${String(orphans.length)} with no library row.` +
      (dryRun ? " Dry run: nothing will be written." : ""),
  );

  const items: RepairedOrphan[] = [];
  const notes: string[] = [];
  /**
   * Rows already spoken for by an earlier orphan in this pass.
   *
   * A real run makes the row's path point at the file it took, so the `onDisk` filter alone
   * would do — but a *dry run* writes nothing, and two files of one recording would both be
   * reported as re-attaching to the same row. The preview has to be the plan.
   */
  const claimed = new Set<string>();
  /**
   * Positions promised to an earlier orphan of the same `(album, coalesce(disc, 1))`.
   *
   * The same reason one level down. A real run writes the row, so the database is the record
   * of what has been handed out and this stays empty; a dry run writes nothing, and without it
   * every file of one album is previewed at the position the first of them took.
   */
  const reserved = new Map<string, Set<number>>();
  /** Album rows a dry run would create, so two files of one folder plan *one* album. */
  const plannedAlbums = new Map<string, AlbumChoice>();
  let albumsCreated = 0;

  /**
   * One orphan, start to finish.
   *
   * It throws, and the loop below is what makes that survivable: a file the database refuses
   * is one line in the report, not the end of the run.
   */
  async function attach(file: WalkedFile): Promise<void> {
    let tags: ReadonlyMap<string, string>;
    let duration: number | null = null;
    try {
      const probe = await box.probe(containerPath(paths, file.path));
      tags = upperKeys((probe.tags ?? {}) as Record<string, unknown>);
      duration = probe.duration ?? null;
    } catch (error) {
      const failure = MMError.from(error);
      notes.push(`Could not read ${file.path}: ${failure.message}`);
      items.push(
        skipped(file.path, baseName(file.path), `the file could not be read: ${failure.message}`),
      );
      return;
    }

    const title = tagValue(tags, "TITLE") ?? baseName(file.path);
    const recordingMbid =
      tagValue(tags, "MUSICBRAINZ_RECORDINGID") ?? tagValue(tags, "MUSICBRAINZ_TRACKID");
    const releaseMbid =
      tagValue(tags, "MUSICBRAINZ_ALBUMID") ?? tagValue(tags, "MUSICBRAINZ_RELEASEID");

    /* ---- rung 1: a row that lost its file ---- */

    /*
     * Candidates are filtered on `onDisk` rather than on `missing_at`.
     *
     * `missing_at` is a fact the *scan* writes, and somebody running the repair has very
     * probably not run a scan first — which would make this rung silently never fire and turn
     * every re-attach into a second row beside the stale one. The walk this function just did
     * knows the same thing first-hand and without a prerequisite.
     */
    const stray =
      recordingMbid === null
        ? undefined
        : (
            await db
              .select({
                id: libraryTracks.id,
                albumId: libraryTracks.albumId,
                path: libraryTracks.path,
                discNumber: libraryTracks.discNumber,
                trackNumber: libraryTracks.trackNumber,
              })
              .from(libraryTracks)
              .innerJoin(libraryAlbums, eq(libraryTracks.albumId, libraryAlbums.id))
              .where(
                and(
                  eq(libraryTracks.recordingMbid, recordingMbid),
                  releaseMbid === null
                    ? eq(libraryAlbums.folder, folderOf(file.path))
                    : or(
                        eq(libraryAlbums.releaseMbid, releaseMbid),
                        eq(libraryAlbums.folder, folderOf(file.path)),
                      ),
                ),
              )
          ).find((row) => !onDisk.has(row.path) && !claimed.has(row.id));

    if (stray !== undefined) {
      claimed.add(stray.id);
      const album = await albumLabel(db, stray.albumId);
      const entry: RepairedOrphan = {
        path: file.path,
        outcome: "reattached",
        title,
        albumId: stray.albumId,
        album,
        albumFoundBy: "recording",
        trackId: stray.id,
        discNumber: stray.discNumber,
        trackNumber: stray.trackNumber,
        recordingMbid,
        releaseMbid,
        provenance: false,
        reason: null,
      };
      await say(
        `${dryRun ? "would reattach" : "reattached"} ${file.path} → “${title}” (${album ?? "—"})`,
      );
      if (!dryRun) {
        await db
          .update(libraryTracks)
          .set({
            path: file.path,
            missingAt: null,
            size: file.size,
            ...(duration === null ? {} : { duration }),
            updatedAt: now,
          })
          .where(eq(libraryTracks.id, stray.id));
      }
      // Pushed once the write has gone through, so an item in the report is something that
      // happened rather than something that was about to be tried.
      items.push(entry);
      return;
    }

    /* ---- rungs 2 and 3: which album ---- */

    /*
     * A dry run has to answer the album question the same way twice.
     *
     * `chooseAlbum` writes the new row it invents, except when it is not allowed to — so in a
     * dry run two files of one unknown folder each get their own invented id, and the preview
     * promises two albums where an `--apply` creates one. Remembered under the key
     * `chooseAlbum` itself decides on: the release first, the folder second.
     */
    const albumKey = `${releaseMbid ?? ""}|${folderOf(file.path)}`;
    const remembered = plannedAlbums.get(albumKey);
    const choice =
      remembered ??
      (await chooseAlbum(db, {
        releaseMbid,
        folder: folderOf(file.path),
        albumTitle: tagValue(tags, "ALBUM"),
        albumArtist: tagValue(tags, "ALBUMARTIST") ?? tagValue(tags, "ARTIST"),
        year: tagNumber(tags, "DATE") ?? tagNumber(tags, "ORIGINALYEAR"),
        dryRun,
        now,
      }));
    if (remembered === undefined) {
      if (choice.created) albumsCreated += 1;
      if (dryRun) plannedAlbums.set(albumKey, choice);
    }

    const document = documentFromTags(tags, now);
    const sourceUrl = sourceUrlOf(tags);
    const discNumber = tagNumber(tags, "DISCNUMBER");
    const bucket = `${choice.id}|${String(discBucket(discNumber))}`;
    let held = reserved.get(bucket);
    if (held === undefined) {
      held = new Set<number>();
      reserved.set(bucket, held);
    }
    const position = await freeAlbumPosition(db, {
      albumId: choice.id,
      discNumber,
      candidate: tagNumber(tags, "TRACKNUMBER"),
      ...(dryRun ? { reserved: held } : {}),
    });

    const entry: RepairedOrphan = {
      path: file.path,
      outcome: "created",
      title,
      albumId: choice.created && dryRun ? null : choice.id,
      album: choice.title,
      albumFoundBy: choice.foundBy,
      trackId: null,
      discNumber,
      trackNumber: position,
      recordingMbid,
      releaseMbid,
      provenance: sourceUrl !== null,
      reason: null,
    };

    await say(
      `${dryRun ? "would attach" : "attached"} ${file.path} → “${title}” ` +
        `(${choice.title}, ${choice.foundBy}, position ${String(position)})`,
    );

    if (dryRun) {
      held.add(position);
      items.push(entry);
      return;
    }

    /*
     * The row goes in **first**, and the position it takes is read one statement before it.
     *
     * Both halves of that sentence are the fix for a real failure. The position used to be
     * decided before `recreateProvenance` ran, four statements earlier, which is a read-then-
     * write with a gap another writer fits into; and the provenance used to be written before
     * the row, so a refused insert left an `import_tracks` row pointing at a file that has no
     * `library_tracks` row — rubbish a second run would then double. Nothing at all is written
     * for a file this insert refuses.
     *
     * Even this read can lose the race, which is why the insert itself retries rather than
     * trusting it.
     */
    const trackId = newId("libraryTrack");
    const finalPosition = await freeAlbumPosition(db, {
      albumId: choice.id,
      discNumber,
      candidate: position,
    });
    const written = await insertLibraryTrack(
      db,
      {
        id: trackId,
        albumId: choice.id,
        recordingMbid,
        trackMbid: tagValue(tags, "MUSICBRAINZ_RELEASETRACKID"),
        title,
        artist: tagValue(tags, "ARTIST"),
        discNumber,
        trackNumber: finalPosition,
        path: file.path,
        format: file.path.split(".").pop() ?? null,
        size: file.size,
        duration,
        tagSchemaVersion: tagNumber(tags, "MUSICMANAGER_TAGSCHEMA"),
        projectionHash: hashProjection(projectDocument(document, formatOf(file.path))),
        updatedAt: now,
      },
      { say },
    );

    const importTrackId =
      sourceUrl === null
        ? null
        : await recreateProvenance(db, {
            albumId: choice.id,
            albumTitle: choice.title,
            releaseMbid,
            recordingMbid,
            sourceUrl,
            title,
            duration,
            libraryPath: file.path,
            position: written.trackNumber ?? finalPosition,
            now,
          });
    if (importTrackId !== null) {
      await db
        .update(libraryTracks)
        .set({ importTrackId, updatedAt: now })
        .where(eq(libraryTracks.id, trackId));
    }

    await db.insert(metadataDocuments).values({
      id: newId("metadataDocument"),
      libraryTrackId: trackId,
      ...(importTrackId === null ? {} : { importTrackId }),
      recordingMbid,
      document: document as unknown as Record<string, unknown>,
      tagSchemaVersion: TAG_SCHEMA_VERSION,
      projectionHash: hashProjection(projectDocument(document, formatOf(file.path))),
      completeness: trackCompleteness(document).score,
      updatedAt: now,
    });

    items.push({ ...entry, trackId, trackNumber: written.trackNumber });
  }

  for (const file of orphans) {
    options.signal?.throwIfAborted();
    try {
      await attach(file);
    } catch (error) {
      // An abort is the operator asking to stop, not a bad file: it ends the walk.
      if (options.signal?.aborted === true) throw error;
      /*
       * Everything else is one file's problem and stays one file's problem.
       *
       * This is what the loop is for. A unique violation on the fourth of nine orphans used to
       * abort `mm library repair-orphans` outright, and the five files behind it were never
       * looked at. They are now, and the refusal is in the report under the file it belongs to.
       */
      const reason = refusalOf(error);
      notes.push(`Could not repair ${file.path}: ${reason}`);
      items.push(failed(file.path, baseName(file.path), reason));
      await say(`failed ${file.path} — ${reason}`);
    }
  }

  if (!dryRun) await refreshCounts(db);

  const report: RepairReport = {
    at: now.toISOString(),
    root,
    dryRun,
    filesSeen: files.length,
    orphans: orphans.length,
    reattached: items.filter((item) => item.outcome === "reattached").length,
    created: items.filter((item) => item.outcome === "created").length,
    skipped: items.filter((item) => item.outcome === "skipped").length,
    failed: items.filter((item) => item.outcome === "failed").length,
    albumsCreated,
    items,
    notes,
  };

  if (!dryRun && report.reattached + report.created > 0) {
    await emit(
      {
        type: "scan.finished",
        level: "info",
        message:
          `Repair: ${String(report.reattached)} row(s) reattached, ` +
          `${String(report.created)} recreated from ${String(report.orphans)} orphan file(s).`,
        data: { reattached: report.reattached, created: report.created },
      },
      db,
    );
  }

  return report;
}

/**
 * What a refusal actually says, which is on the driver's error and not on Drizzle's.
 *
 * Drizzle's `message` is the failed statement and its parameters — the half that carries the
 * data and none of the diagnosis; it is what turned a duplicate key into an unreadable wall of
 * `UNKNOWN: Failed query: insert into "library_tracks" … params: …`. Postgres already said
 * which rule was broken, and that is the sentence the report is for.
 */
function refusalOf(error: unknown): string {
  const failure = MMError.from(error);
  const cause = (error as { cause?: unknown }).cause as
    { constraint_name?: string; message?: string } | undefined;
  if (cause?.constraint_name === undefined) return failure.message;
  return `${cause.message ?? failure.message} (${cause.constraint_name})`;
}

/** A file the repair could not even try — its reason is what it could not read. */
function skipped(path: string, title: string, reason: string): RepairedOrphan {
  return entry(path, "skipped", title, reason);
}

/** A file the repair tried to write and was refused. The run carries on without it. */
function failed(path: string, title: string, reason: string): RepairedOrphan {
  return entry(path, "failed", title, reason);
}

function entry(
  path: string,
  outcome: "skipped" | "failed",
  title: string,
  reason: string,
): RepairedOrphan {
  return {
    path,
    outcome,
    title,
    albumId: null,
    album: null,
    albumFoundBy: null,
    trackId: null,
    discNumber: null,
    trackNumber: null,
    recordingMbid: null,
    releaseMbid: null,
    provenance: false,
    reason,
  };
}

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return (index === -1 ? path : path.slice(index + 1)).replace(/\.[^./]+$/, "");
}

async function albumLabel(db: Database, albumId: string | null): Promise<string | null> {
  if (albumId === null) return null;
  const [row] = await db
    .select({ artist: libraryAlbums.albumArtist, title: libraryAlbums.title })
    .from(libraryAlbums)
    .where(eq(libraryAlbums.id, albumId))
    .limit(1);
  return row === undefined ? null : `${row.artist} — ${row.title}`;
}

/** Rungs 2 and 3: the release's album, then the folder's, then a new row. */
async function chooseAlbum(
  db: Database,
  input: {
    readonly releaseMbid: string | null;
    readonly folder: string;
    readonly albumTitle: string | null;
    readonly albumArtist: string | null;
    readonly year: number | null;
    readonly dryRun: boolean;
    readonly now: Date;
  },
): Promise<AlbumChoice> {
  if (input.releaseMbid !== null) {
    const rows = await db
      .select({
        id: libraryAlbums.id,
        folder: libraryAlbums.folder,
        artist: libraryAlbums.albumArtist,
        title: libraryAlbums.title,
      })
      .from(libraryAlbums)
      .where(eq(libraryAlbums.releaseMbid, input.releaseMbid))
      .orderBy(libraryAlbums.createdAt);
    // The row whose folder is the file's own, when there is one: that is the album the file is
    // physically sitting in, and preferring it keeps a repair from moving a track across a
    // release still split over two rows.
    const chosen = rows.find((row) => row.folder === input.folder) ?? rows[0];
    if (chosen !== undefined) {
      return {
        id: chosen.id,
        title: `${chosen.artist} — ${chosen.title}`,
        foundBy: "release",
        created: false,
      };
    }
  }

  const [byFolder] = await db
    .select({ id: libraryAlbums.id, artist: libraryAlbums.albumArtist, title: libraryAlbums.title })
    .from(libraryAlbums)
    .where(eq(libraryAlbums.folder, input.folder))
    .limit(1);
  if (byFolder !== undefined) {
    return {
      id: byFolder.id,
      title: `${byFolder.artist} — ${byFolder.title}`,
      foundBy: "folder",
      created: false,
    };
  }

  const artist = input.albumArtist ?? "Unknown Artist";
  const title =
    input.albumTitle ?? (input.folder === "" ? "Unknown Album" : baseName(input.folder));
  const id = newId("libraryAlbum");
  if (!input.dryRun) {
    await db.insert(libraryAlbums).values({
      id,
      releaseMbid: input.releaseMbid,
      albumArtist: artist,
      title,
      year: input.year,
      folder: input.folder,
      updatedAt: input.now,
    });
  }
  return { id, title: `${artist} — ${title}`, foundBy: "new", created: true };
}

/**
 * Recreate the import a repaired file came from, so `retag` will still rebuild it.
 *
 * `retagOne` refuses a library track with no import behind it — "there are no sources to
 * rebuild it from" — so a repair that only wrote a `library_tracks` row would put the track
 * back in the Console and leave it permanently un-repairable. The file's `Source:` comment is
 * the provenance v1 and v2 both wrote, and it is enough to build the import from.
 *
 * One import per album per repair, reused across the album's files: `imports.url` is not
 * unique, but two imports for one album would prune each other's `import_tracks` by position
 * the next time the album is migrated.
 */
async function recreateProvenance(
  db: Database,
  input: {
    readonly albumId: string;
    readonly albumTitle: string;
    readonly releaseMbid: string | null;
    readonly recordingMbid: string | null;
    readonly sourceUrl: string;
    readonly title: string;
    readonly duration: number | null;
    readonly libraryPath: string;
    readonly position: number;
    readonly now: Date;
  },
): Promise<string> {
  const [sibling] = await db
    .select({ importId: libraryTracks.importId })
    .from(libraryTracks)
    .where(and(eq(libraryTracks.albumId, input.albumId), isNotNull(libraryTracks.importId)))
    .limit(1);

  let importId = sibling?.importId ?? null;
  if (importId === null) {
    importId = newId("import");
    await db.insert(imports).values({
      id: importId,
      url: input.sourceUrl,
      kind: "album",
      status: "done",
      step: "verify",
      releaseMbid: input.releaseMbid,
      title: input.albumTitle,
      updatedAt: input.now,
      finishedAt: input.now,
    });
  }

  // Past the end of whatever the import already holds: a repaired track is an addition, and
  // overwriting an existing position would take another track's provenance away.
  const [highest] = await db
    .select({ max: sql<number | null>`max(${importTracks.position})` })
    .from(importTracks)
    .where(eq(importTracks.importId, importId));

  const importTrackId = newId("importTrack");
  await db.insert(importTracks).values({
    id: importTrackId,
    importId,
    position: (highest?.max ?? -1) + 1,
    videoId: videoIdOf(input.sourceUrl) ?? input.libraryPath,
    url: input.sourceUrl,
    sourceTitle: input.title,
    sourceDuration: input.duration,
    role: "mapped",
    state: "done",
    recordingMbid: input.recordingMbid,
    trackTitle: input.title,
    trackPosition: input.position,
    libraryPath: input.libraryPath,
    note: "recreated by `mm library repair-orphans` from the file's own tags",
    updatedAt: input.now,
  });
  return importTrackId;
}

function videoIdOf(url: string): string | null {
  const match = /[?&]v=([\w-]{11})|youtu\.be\/([\w-]{11})/.exec(url);
  return match?.[1] ?? match?.[2] ?? null;
}

/**
 * `track_count` and `present_count`, recomputed for every album the repair touched.
 *
 * This was the fifth writer of that pair, and the fifth definition of it: one `update … from`
 * that set the total to the row count. It now delegates to `services/album-counters.ts` like
 * everything else, which is what makes `track_count` mean the same thing on an album the
 * repair rebuilt as on one the importer placed. An album every track left still comes out
 * `0/0`; the helper reaches that by counting nothing, not by a special case.
 */
async function refreshCounts(db: Database): Promise<void> {
  await recountAlbums(db);
}
