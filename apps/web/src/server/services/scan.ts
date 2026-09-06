/**
 * `scan.service` — walking the library and reconciling it with the database.
 *
 * The premise of this project is that *the database is the source of truth and the files are
 * a projection of it* (`CLAUDE.md`). That premise is only worth anything if something checks
 * it, because in practice the two drift apart in four specific ways, and each one has a
 * different remedy:
 *
 *  - **orphan** — a file the database has never heard of. Somebody copied it in, or a rename
 *    happened outside the app. It can be identified by fingerprint, or moved to the trash.
 *  - **missing** — a row whose file is gone. The import that produced it is still known, so
 *    the fix is a re-download that keeps the existing mapping rather than a new import.
 *  - **drift** — the tags in the file are not the ones the document projects. Somebody edited
 *    them by hand, or a re-tag was interrupted. The fix is to re-write the projection.
 *  - **duplicate** — the same recording MBID under two paths. Not always wrong (an album and
 *    a compilation legitimately share a recording), so it is *reported*, never auto-resolved.
 *
 * Nothing here deletes anything. `delete` is a move into the trash directory, because a scan
 * that unlinks files on a heuristic is a scan you would be right never to run.
 */
import { existsSync, readdirSync, renameSync, statSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { and, asc, desc, eq, isNotNull, sql } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { projectDocument, type TrackDocument } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  libraryAlbums,
  libraryScans,
  libraryTracks,
  metadataDocuments,
  type LibraryScan,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { containerPath, hostPath, toPosix, type PathMap } from "#/server/paths.ts";
import { toolbox as defaultToolbox, type ToolboxClient } from "#/server/toolbox/client.ts";
import { emit } from "#/server/services/events.ts";
import { closeLibraryItem, openLibraryItem } from "#/server/services/library-inbox.ts";
import { resolvePaths } from "#/server/services/jobs/context.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";

/** What counts as a track. Everything else in the tree is a sidecar or somebody's notes. */
export const AUDIO_EXTENSIONS = [
  ".opus",
  ".flac",
  ".mp3",
  ".m4a",
  ".ogg",
  ".oga",
  ".wav",
  ".aac",
  ".wma",
  ".alac",
] as const;

/**
 * Directories the walker never descends into.
 *
 * `.mm-work` is the download staging area inside the library (`CLAUDE.md`), so half-finished
 * files live there by design and are not orphans. Everything dot-prefixed is skipped on the
 * same principle Navidrome's own scanner uses.
 */
function skippable(name: string): boolean {
  return name.startsWith(".") || name === "@eaDir" || name === "lost+found";
}

export function isAudio(path: string): boolean {
  const lower = path.toLowerCase();
  return AUDIO_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

export interface WalkedFile {
  /** Library-relative, forward slashes — the same spelling `library_tracks.path` uses. */
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: string;
}

/**
 * Every audio file under `root`, library-relative.
 *
 * Synchronous on purpose: this is a single pass over a directory tree on local disk, it runs
 * in a worker job rather than in a request, and the async version would buy nothing but a
 * thousand promises.
 */
export function walkLibrary(root: string, limit = 200_000): WalkedFile[] {
  const out: WalkedFile[] = [];
  if (!existsSync(root)) return out;

  const stack: string[] = [root];
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // A directory we may not read is not a finding; it is somebody else's business.
      continue;
    }
    for (const entry of entries) {
      if (skippable(entry.name)) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile() || !isAudio(entry.name)) continue;
      const stats = statSync(full);
      out.push({
        path: toPosix(full.slice(root.length).replace(/^[\\/]+/, "")),
        size: stats.size,
        modifiedAt: stats.mtime.toISOString(),
      });
      if (out.length >= limit) break;
    }
  }
  return out.sort((left, right) => left.path.localeCompare(right.path));
}

/* ------------------------------------------------------------------ */
/* the report                                                          */
/* ------------------------------------------------------------------ */

export interface OrphanFile {
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: string;
}

export interface MissingFile {
  readonly trackId: string;
  readonly albumId: string | null;
  readonly title: string;
  readonly album: string | null;
  readonly path: string;
  readonly importId: string | null;
  readonly importTrackId: string | null;
}

export interface DriftedField {
  readonly field: string;
  readonly key: string;
  readonly db: string;
  readonly file: string;
}

export interface DriftedTrack {
  readonly trackId: string;
  readonly albumId: string | null;
  readonly title: string;
  readonly path: string;
  readonly fields: readonly DriftedField[];
}

export interface DuplicateGroup {
  readonly recordingMbid: string;
  readonly title: string;
  readonly files: readonly { readonly trackId: string; readonly path: string }[];
}

/** One row merged away because another row was the same track under another name. */
export interface MergedTrack {
  readonly keptId: string;
  readonly keptPath: string;
  readonly removedId: string;
  readonly removedPath: string;
  readonly on: "recording" | "position";
}

export interface ScanReport {
  readonly at: string;
  readonly root: string;
  readonly durationMs: number;
  readonly filesSeen: number;
  readonly tracked: number;
  readonly orphans: readonly OrphanFile[];
  readonly missing: readonly MissingFile[];
  readonly drift: readonly DriftedTrack[];
  readonly duplicates: readonly DuplicateGroup[];
  /**
   * Rows that were the *same track under two paths* and have been merged into one.
   *
   * Distinct from `duplicates`, which is two files of the same recording and is reported and
   * never touched. This is one file and two rows — a bookkeeping error, not a decision.
   */
  readonly merged: readonly MergedTrack[];
  /** True when the drift pass stopped at its cap rather than at the end of the library. */
  readonly driftTruncated: boolean;
  readonly probed: number;
  readonly notes: readonly string[];
}

export interface ScanOptions {
  readonly db?: Database;
  readonly settings?: Settings;
  readonly toolbox?: ToolboxClient;
  readonly paths?: PathMap;
  /** `cron`, `manual`, `cli` — kept so the Tools page can say why a run happened. */
  readonly trigger?: string;
  /**
   * How many tracked files get their tags read back through `/probe`.
   *
   * Drift detection is the expensive half of a scan — one subprocess per file — so the
   * nightly run caps it and says so rather than taking an hour on a large library.
   */
  readonly driftLimit?: number;
  readonly signal?: AbortSignal;
  readonly say?: (message: string) => Promise<void>;
}

/* ------------------------------------------------------------------ */
/* drift                                                               */
/* ------------------------------------------------------------------ */

/**
 * Compare the tags in a file against the projection of its document.
 *
 * Only the fields the document actually projects are compared: a file carrying an extra tag
 * somebody added is not drift, it is a tag we do not manage. Multi-valued fields are compared
 * as a case-insensitive set, for the same reason the read-back does — order is not meaning.
 */
export function compareTags(
  document: TrackDocument,
  fileTags: Readonly<Record<string, unknown>>,
): DriftedField[] {
  const expected = new Map<string, string[]>();
  const fieldOf = new Map<string, string>();
  for (const tag of projectDocument(document, "vorbis")) {
    const key = tag.key.toUpperCase();
    const held = expected.get(key);
    if (held === undefined) expected.set(key, [tag.value]);
    else held.push(tag.value);
    fieldOf.set(key, tag.field);
  }

  /*
   * What ffprobe reports is not quite what mutagen wrote, in two specific ways — and both,
   * left uncorrected, report *every file in the library* as drifted:
   *
   *  - a **repeated** Vorbis comment comes back as one string with the values joined by `;`
   *    (`Thomas Bangalter;Guy-Manuel de Homem-Christo`), not as a list;
   *  - a few keys are **renamed** into ffmpeg's own generic vocabulary, so `ALBUMARTIST`
   *    arrives as `ALBUM_ARTIST`, `TRACKNUMBER` as `TRACK`, `DISCNUMBER` as `DISC`.
   *
   * Splitting on `;` is safe where splitting on `,` would not be: `COMPOSERSORT` legitimately
   * carries a comma inside one value (`Bangalter, Thomas`).
   */
  const actual = new Map<string, string[]>();
  for (const [key, value] of Object.entries(fileTags)) {
    const upper = key.toUpperCase();
    const values = Array.isArray(value)
      ? value.map((item) => String(item))
      : String(value ?? "").split(/[;\n]/);
    actual.set(
      upper,
      values.map((item) => item.trim()).filter((item) => item !== ""),
    );
  }

  const out: DriftedField[] = [];
  for (const [key, values] of expected) {
    // Pictures and lyrics do not survive ffprobe's tag dictionary in a comparable form.
    if (SKIP_DRIFT.has(key)) continue;
    const alias = FFPROBE_ALIASES[key];
    const got = actual.get(key) ?? (alias === undefined ? [] : (actual.get(alias) ?? []));
    const left = new Set(values.map((value) => value.trim().toLowerCase()));
    const right = new Set(got.map((value) => value.trim().toLowerCase()));
    const same = left.size === right.size && [...left].every((value) => right.has(value));
    if (same) continue;
    out.push({
      field: fieldOf.get(key) ?? key.toLowerCase(),
      key,
      db: values.join(", "),
      file: got.length === 0 ? "—" : got.join(", "),
    });
  }
  return out;
}

/**
 * Keys the comparison cannot judge from an ffprobe dictionary.
 *
 * `LYRICS` is megabytes of LRC that ffprobe truncates, and the picture blocks are binary.
 * Reporting them as drift on every single file would drown the four real findings.
 */
/**
 * The canonical Vorbis keys ffmpeg renames on the way out.
 *
 * Measured against the toolbox's own `/probe` on a file this project wrote, not guessed:
 * everything else in the Picard table comes back under the name mutagen used.
 */
const FFPROBE_ALIASES: Readonly<Record<string, string>> = {
  ALBUMARTIST: "ALBUM_ARTIST",
  TRACKNUMBER: "TRACK",
  DISCNUMBER: "DISC",
};

const SKIP_DRIFT = new Set([
  "LYRICS",
  "UNSYNCEDLYRICS",
  "METADATA_BLOCK_PICTURE",
  "COVERART",
  "ACOUSTID_FINGERPRINT",
]);

/* ------------------------------------------------------------------ */
/* two rows, one track                                                 */
/* ------------------------------------------------------------------ */

/**
 * Merge `library_tracks` rows that describe the same track under two paths.
 *
 * This is the disk-aware half of the fix for the duplication a `pathTemplate` change caused
 * (`orchestration/feedback/2026-09-07-mcp-test-report-2.md` §C). The unique indexes stop it
 * happening again and the migration made the existing data satisfy them, but only a process
 * that can *stat a file* knows which of two rows is the ghost — and that is this one, because
 * the scan has just walked the tree.
 *
 * The rule is exactly the one the report asks for: **keep the row whose file exists.** When
 * both exist, or neither does, keep the one the rest of the app already points at (a metadata
 * document, then an import, then the most recent write) — the same order the migration uses,
 * so the two never disagree.
 *
 * Two identities, in the order of how much they prove: the recording MBID inside the album,
 * then the position inside it. Nothing outside an album is touched: a row with no `album_id`
 * has no identity to be duplicated *against*.
 */
export async function mergeDuplicateTracks(
  db: Database,
  onDisk: ReadonlySet<string>,
): Promise<MergedTrack[]> {
  const rows = await db
    .select({
      id: libraryTracks.id,
      albumId: libraryTracks.albumId,
      recordingMbid: libraryTracks.recordingMbid,
      discNumber: libraryTracks.discNumber,
      trackNumber: libraryTracks.trackNumber,
      path: libraryTracks.path,
      importTrackId: libraryTracks.importTrackId,
      updatedAt: libraryTracks.updatedAt,
    })
    .from(libraryTracks);

  const documented = new Set(
    (
      await db
        .select({ id: metadataDocuments.libraryTrackId })
        .from(metadataDocuments)
        .where(isNotNull(metadataDocuments.libraryTrackId))
    )
      .map((row) => row.id)
      .filter((id): id is string => id !== null),
  );

  type Row = (typeof rows)[number];
  /** Strongest evidence first; a lower number wins. */
  const rank = (row: Row): readonly number[] => [
    onDisk.has(row.path) ? 0 : 1,
    documented.has(row.id) ? 0 : 1,
    row.importTrackId === null ? 1 : 0,
    -row.updatedAt.getTime(),
  ];
  const better = (a: Row, b: Row): Row => {
    const left = rank(a);
    const right = rank(b);
    for (let i = 0; i < left.length; i += 1) {
      if ((left[i] ?? 0) !== (right[i] ?? 0)) return (left[i] ?? 0) < (right[i] ?? 0) ? a : b;
    }
    return a.id <= b.id ? a : b;
  };

  const groups = new Map<string, { on: "recording" | "position"; rows: Row[] }>();
  for (const row of rows) {
    if (row.albumId === null) continue;
    const key =
      row.recordingMbid !== null && row.recordingMbid !== ""
        ? { on: "recording" as const, key: `r:${row.albumId}:${row.recordingMbid}` }
        : row.trackNumber === null
          ? null
          : {
              on: "position" as const,
              key: `p:${row.albumId}:${String(row.discNumber ?? 1)}:${String(row.trackNumber)}`,
            };
    if (key === null) continue;
    const group = groups.get(key.key) ?? { on: key.on, rows: [] };
    group.rows.push(row);
    groups.set(key.key, group);
  }

  const merged: MergedTrack[] = [];
  for (const group of groups.values()) {
    if (group.rows.length < 2) continue;
    const keep = group.rows.reduce(better);
    for (const row of group.rows) {
      if (row.id === keep.id) continue;
      // The document follows the row that survives, so a re-tag still has something to project
      // — the alternative is a `metadata_documents` row pointing at nothing.
      if (!documented.has(keep.id)) {
        await db
          .update(metadataDocuments)
          .set({ libraryTrackId: keep.id, updatedAt: new Date() })
          .where(eq(metadataDocuments.libraryTrackId, row.id));
        documented.add(keep.id);
      }
      await db.delete(libraryTracks).where(eq(libraryTracks.id, row.id));
      merged.push({
        keptId: keep.id,
        keptPath: keep.path,
        removedId: row.id,
        removedPath: row.path,
        on: group.on,
      });
    }
  }

  return merged;
}

/**
 * Recount `track_count` and `present_count` from the rows that are actually there.
 *
 * Called after a merge, because the counters were computed when the ghosts still existed —
 * one album reported twenty-five tracks for a thirteen-track record, and the completeness
 * score was a fraction of that twenty-five.
 */
async function refreshAlbumCounts(
  db: Database,
  onDisk: ReadonlyMap<string, WalkedFile>,
): Promise<void> {
  const rows = await db
    .select({ albumId: libraryTracks.albumId, path: libraryTracks.path })
    .from(libraryTracks)
    .where(isNotNull(libraryTracks.albumId));

  const counts = new Map<string, { total: number; present: number }>();
  for (const row of rows) {
    if (row.albumId === null) continue;
    const held = counts.get(row.albumId) ?? { total: 0, present: 0 };
    held.total += 1;
    if (onDisk.has(row.path)) held.present += 1;
    counts.set(row.albumId, held);
  }

  for (const [albumId, count] of counts) {
    await db
      .update(libraryAlbums)
      .set({ trackCount: count.total, presentCount: count.present, updatedAt: new Date() })
      .where(eq(libraryAlbums.id, albumId));
  }
}

/* ------------------------------------------------------------------ */
/* the scan                                                            */
/* ------------------------------------------------------------------ */

/**
 * Walk the library once and reconcile it.
 *
 * The run is recorded before it starts and updated when it ends, so a scan killed halfway
 * leaves a `running` row that says when it began rather than nothing at all.
 */
export async function runScan(options: ScanOptions = {}): Promise<{
  readonly scan: LibraryScan;
  readonly report: ScanReport;
}> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const paths = options.paths ?? resolvePaths(settings);
  const box = options.toolbox ?? defaultToolbox();
  const say = options.say ?? (async () => {});
  const started = Date.now();
  const id = newId("libraryScan");

  await db.insert(libraryScans).values({ id, trigger: options.trigger ?? "manual" });

  try {
    const root = paths.host;
    await say(`Walking ${root}.`);
    const files = walkLibrary(root);
    const onDisk = new Map(files.map((file) => [file.path, file]));

    /*
     * Merge before counting anything.
     *
     * Otherwise every number below — `tracked`, `missing`, the album counters — is computed on
     * rows that are about to disappear, and the report would describe a library that no longer
     * exists by the time it is read.
     */
    const merged = await mergeDuplicateTracks(db, new Set(onDisk.keys()));
    if (merged.length > 0) {
      await refreshAlbumCounts(db, onDisk);
      await say(`Merged ${String(merged.length)} duplicate library row(s).`);
    }

    const rows = await db
      .select({
        id: libraryTracks.id,
        albumId: libraryTracks.albumId,
        path: libraryTracks.path,
        title: libraryTracks.title,
        recordingMbid: libraryTracks.recordingMbid,
        importId: libraryTracks.importId,
        importTrackId: libraryTracks.importTrackId,
      })
      .from(libraryTracks);

    const tracked = new Set(rows.map((row) => row.path));

    /* ---- orphans and missing ---- */

    const orphans: OrphanFile[] = files
      .filter((file) => !tracked.has(file.path))
      .map((file) => ({ path: file.path, size: file.size, modifiedAt: file.modifiedAt }));

    const albumTitles = new Map(
      (
        await db.select({ id: libraryAlbums.id, title: libraryAlbums.title }).from(libraryAlbums)
      ).map((album) => [album.id, album.title]),
    );

    const missing: MissingFile[] = rows
      .filter((row) => !onDisk.has(row.path))
      .map((row) => ({
        trackId: row.id,
        albumId: row.albumId,
        title: row.title,
        album: row.albumId === null ? null : (albumTitles.get(row.albumId) ?? null),
        path: row.path,
        importId: row.importId,
        importTrackId: row.importTrackId,
      }));

    /* ---- duplicates ---- */

    const byRecording = new Map<
      string,
      { title: string; files: { trackId: string; path: string }[] }
    >();
    for (const row of rows) {
      if (row.recordingMbid === null || row.recordingMbid === "") continue;
      const group = byRecording.get(row.recordingMbid) ?? { title: row.title, files: [] };
      group.files.push({ trackId: row.id, path: row.path });
      byRecording.set(row.recordingMbid, group);
    }
    const duplicates: DuplicateGroup[] = [...byRecording.entries()]
      .filter(([, group]) => group.files.length > 1)
      .map(([recordingMbid, group]) => ({
        recordingMbid,
        title: group.title,
        files: group.files,
      }));

    /* ---- drift ---- */

    const notes: string[] = [];
    const present = rows.filter((row) => onDisk.has(row.path));
    const limit = options.driftLimit ?? 500;
    const candidates = present.slice(0, limit);
    const driftTruncated = present.length > candidates.length;
    if (driftTruncated) {
      notes.push(
        `Tag drift was checked on the first ${String(candidates.length)} of ${String(present.length)} files; raise the limit to check them all.`,
      );
    }

    const documents = new Map<string, TrackDocument>();
    if (candidates.length > 0) {
      const documentRows = await db
        .select({
          libraryTrackId: metadataDocuments.libraryTrackId,
          document: metadataDocuments.document,
        })
        .from(metadataDocuments)
        .where(isNotNull(metadataDocuments.libraryTrackId));
      for (const row of documentRows) {
        if (row.libraryTrackId !== null) {
          documents.set(row.libraryTrackId, row.document as unknown as TrackDocument);
        }
      }
    }

    const drift: DriftedTrack[] = [];
    let probed = 0;
    for (const row of candidates) {
      if (options.signal?.aborted === true) {
        notes.push("The scan was stopped before the drift pass finished.");
        break;
      }
      const document = documents.get(row.id);
      if (document === undefined) continue;
      let tags: Record<string, unknown>;
      try {
        const probe = await box.probe(containerPath(paths, row.path));
        probed += 1;
        tags = (probe.tags ?? {}) as Record<string, unknown>;
      } catch (error) {
        notes.push(`Could not probe ${row.path}: ${MMError.from(error).message}`);
        continue;
      }
      const fields = compareTags(document, tags);
      if (fields.length > 0) {
        drift.push({
          trackId: row.id,
          albumId: row.albumId,
          title: row.title,
          path: row.path,
          fields,
        });
      }
    }

    const report: ScanReport = {
      at: new Date().toISOString(),
      root,
      durationMs: Date.now() - started,
      filesSeen: files.length,
      tracked: rows.length,
      orphans,
      missing,
      drift,
      duplicates,
      merged,
      driftTruncated,
      probed,
      notes,
    };

    const [scan] = await db
      .update(libraryScans)
      .set({
        status: "done",
        finishedAt: new Date(),
        durationMs: report.durationMs,
        filesSeen: report.filesSeen,
        tracked: report.tracked,
        orphans: orphans.length,
        missing: missing.length,
        drift: drift.length,
        duplicates: duplicates.length,
        report: report as unknown as Record<string, unknown>,
      })
      .where(eq(libraryScans.id, id))
      .returning();

    await raiseScanItems(db, report);
    await emit(
      {
        type: "scan.finished",
        level: orphans.length + missing.length + drift.length > 0 ? "warn" : "info",
        message: `Scan: ${String(files.length)} files, ${String(orphans.length)} orphan(s), ${String(missing.length)} missing, ${String(drift.length)} drifted, ${String(duplicates.length)} duplicate group(s).`,
        data: {
          scanId: id,
          orphans: orphans.length,
          missing: missing.length,
          drift: drift.length,
          duplicates: duplicates.length,
        },
      },
      db,
    );

    if (scan === undefined) throw new MMError("UNKNOWN", "The scan row vanished mid-run.");
    return { scan, report };
  } catch (error) {
    const failure = MMError.from(error);
    await db
      .update(libraryScans)
      .set({
        status: "failed",
        finishedAt: new Date(),
        durationMs: Date.now() - started,
        error: failure.message,
      })
      .where(eq(libraryScans.id, id));
    throw failure;
  }
}

/**
 * Turn a report into Inbox items — one per finding *kind*, not one per file.
 *
 * Two hundred orphan files after a botched copy is one question ("what do I do with these?"),
 * not two hundred. Duplicates are per recording, because that is the unit you decide about.
 */
async function raiseScanItems(db: Database, report: ScanReport): Promise<void> {
  if (report.orphans.length > 0) {
    await openLibraryItem(
      {
        type: "orphan_files",
        subject: "scan:orphans",
        title: `${String(report.orphans.length)} file(s) in the library are not in the database`,
        summary: report.orphans
          .slice(0, 3)
          .map((orphan) => orphan.path)
          .join(" · "),
        payload: { orphans: report.orphans.slice(0, 200), total: report.orphans.length },
        preselected: { action: "identify" },
      },
      db,
    );
  } else {
    await closeLibraryItem("orphan_files", "scan:orphans", db);
  }

  for (const group of report.duplicates) {
    await openLibraryItem(
      {
        type: "duplicate_recording",
        subject: `recording:${group.recordingMbid}`,
        title: `“${group.title}” is in the library ${String(group.files.length)} times`,
        summary: group.files.map((file) => file.path).join(" · "),
        payload: { ...group },
        preselected: { action: "keep_all" },
      },
      db,
    );
  }
}

/* ------------------------------------------------------------------ */
/* the actions the report offers                                       */
/* ------------------------------------------------------------------ */

/**
 * Move a file to the trash. **Never** unlink it.
 *
 * The destination keeps the library-relative path under a timestamped run directory, so two
 * deletions of the same track name do not overwrite each other and so putting one back is a
 * move rather than a puzzle.
 */
export function trashFile(
  paths: PathMap,
  relative: string,
  trashDir: string,
  now: Date = new Date(),
): { readonly from: string; readonly to: string } {
  const source = hostPath(paths, relative);
  if (!existsSync(source)) {
    throw new MMError("NOT_FOUND", `${relative} is not on disk.`, {
      hint: "Run the scan again; the report may be stale.",
    });
  }
  const stamp = now.toISOString().slice(0, 19).replace(/[:T]/g, "-");
  const destination = resolve(join(trashDir, stamp, relative));
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(source, destination);
  return { from: relative, to: destination };
}

/** Fingerprint an orphan and ask AcoustID what it is. The report's "Identify" button. */
export async function identifyOrphan(
  relative: string,
  options: { settings?: Settings; toolbox?: ToolboxClient; paths?: PathMap; db?: Database } = {},
): Promise<{
  readonly path: string;
  readonly duration: number | null;
  readonly candidates: readonly {
    readonly recordingMbid: string | null;
    readonly title: string;
    readonly artist: string;
    readonly score: number;
  }[];
}> {
  const settings = options.settings ?? (await loadSettings(options.db));
  const paths = options.paths ?? resolvePaths(settings);
  const box = options.toolbox ?? defaultToolbox();
  const key =
    settings.acoustidKey.trim() === "" ? process.env.MM_ACOUSTID_KEY : settings.acoustidKey;

  const result = await box.fingerprint(containerPath(paths, relative), key ?? undefined);
  const candidates = (result.candidates ?? []).map((candidate) => ({
    recordingMbid: candidate.recording_mbid,
    title: candidate.title ?? "unknown",
    artist: candidate.artist ?? "",
    score: candidate.score,
  }));

  return { path: relative, duration: result.duration, candidates };
}

/** The last runs, newest first. What the Tools card shows. */
export async function recentScans(limit = 10, db: Database = defaultDb()): Promise<LibraryScan[]> {
  return await db.select().from(libraryScans).orderBy(desc(libraryScans.startedAt)).limit(limit);
}

/** The newest finished run, with its report. */
export async function lastScan(db: Database = defaultDb()): Promise<LibraryScan | null> {
  const [row] = await db
    .select()
    .from(libraryScans)
    .where(eq(libraryScans.status, "done"))
    .orderBy(desc(libraryScans.startedAt))
    .limit(1);
  return row ?? null;
}

/** The report of one run, parsed. */
export function reportOf(scan: LibraryScan): ScanReport | null {
  return scan.report === null ? null : (scan.report as unknown as ScanReport);
}

/** One run by id. */
export async function getScan(id: string, db: Database = defaultDb()): Promise<LibraryScan | null> {
  const [row] = await db.select().from(libraryScans).where(eq(libraryScans.id, id)).limit(1);
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* the report, small enough to read                                    */
/* ------------------------------------------------------------------ */

export interface ScanSummary {
  readonly scanId: string;
  readonly status: string;
  readonly trigger: string;
  readonly startedAt: string;
  readonly finishedAt: string | null;
  readonly durationMs: number | null;
  readonly error: string | null;
  /** Every finding, counted in full — these never depend on `limit`. */
  readonly counts: {
    readonly filesSeen: number;
    readonly tracked: number;
    readonly orphans: number;
    readonly missing: number;
    readonly drift: number;
    readonly duplicates: number;
    readonly merged: number;
    readonly probed: number;
  };
  readonly orphans: { readonly items: readonly OrphanFile[]; readonly more: number };
  readonly missing: { readonly items: readonly MissingFile[]; readonly more: number };
  readonly drift: { readonly items: readonly DriftedTrack[]; readonly more: number };
  readonly duplicates: { readonly items: readonly DuplicateGroup[]; readonly more: number };
  readonly merged: { readonly items: readonly MergedTrack[]; readonly more: number };
  readonly driftTruncated: boolean;
  readonly notes: readonly string[];
}

/**
 * A scan report an agent can actually read.
 *
 * The stored report holds every orphan and every drifted field, which is right for the Console
 * (it paginates) and useless over MCP, where the answer is one JSON blob in a context window.
 * Each list is cut to `limit` and told how many it left behind — from the **full** array, never
 * from the slice, which is the mistake `moreErrors`/`moreDiffs` made in `retag`.
 */
export function summariseScan(scan: LibraryScan, limit = 10): ScanSummary {
  const report = reportOf(scan);
  const cut = <T>(rows: readonly T[] | undefined): { items: readonly T[]; more: number } => {
    const all = rows ?? [];
    return { items: all.slice(0, limit), more: Math.max(0, all.length - limit) };
  };

  return {
    scanId: scan.id,
    status: scan.status,
    trigger: scan.trigger,
    startedAt: scan.startedAt.toISOString(),
    finishedAt: scan.finishedAt?.toISOString() ?? null,
    durationMs: scan.durationMs,
    error: scan.error,
    counts: {
      filesSeen: report?.filesSeen ?? scan.filesSeen,
      tracked: report?.tracked ?? scan.tracked,
      orphans: report?.orphans.length ?? scan.orphans,
      missing: report?.missing.length ?? scan.missing,
      drift: report?.drift.length ?? scan.drift,
      duplicates: report?.duplicates.length ?? scan.duplicates,
      merged: report?.merged?.length ?? 0,
      probed: report?.probed ?? 0,
    },
    orphans: cut(report?.orphans),
    missing: cut(report?.missing),
    drift: cut(report?.drift),
    duplicates: cut(report?.duplicates),
    merged: cut(report?.merged),
    driftTruncated: report?.driftTruncated ?? false,
    notes:
      report?.notes ??
      (scan.status === "done" ? [] : [`This scan is \`${scan.status}\`, so it has no report yet.`]),
  };
}

/** How many library tracks there are at all — the denominator of every scan number. */
export async function libraryCounts(
  db: Database = defaultDb(),
): Promise<{ albums: number; tracks: number }> {
  const [albums] = await db.select({ count: sql<number>`count(*)::int` }).from(libraryAlbums);
  const [tracks] = await db.select({ count: sql<number>`count(*)::int` }).from(libraryTracks);
  return { albums: albums?.count ?? 0, tracks: tracks?.count ?? 0 };
}

/** Albums ordered for a full verify sweep. Exported for `mm verify --all` and Tools. */
export async function albumIdsForVerify(db: Database = defaultDb()): Promise<string[]> {
  const rows = await db
    .select({ id: libraryAlbums.id })
    .from(libraryAlbums)
    .where(and(isNotNull(libraryAlbums.folder)))
    .orderBy(asc(libraryAlbums.folder));
  return rows.map((row) => row.id);
}
