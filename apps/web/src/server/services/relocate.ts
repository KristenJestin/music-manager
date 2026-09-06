/**
 * Re-file the library against the current `pathTemplate` — the other half of decision 074.
 *
 * 074 changed the default layout and said, in as many words, that *the files already placed
 * keep their names*: only a new placement follows the new template, so a library becomes
 * mixed the moment the setting changes and stays that way. That was the honest thing to ship
 * and the wrong thing to leave. `retag` re-projects the tags; nothing re-projected the paths,
 * and the MCP test report (§11) found a library still in `NN Titre.opus` with no recourse.
 *
 * What this does, and only this:
 *
 *  - **render** each library track's target path from its metadata document, exactly as
 *    `place` does — same function, same options, so a relocate and a fresh import cannot
 *    disagree about where a file belongs;
 *  - **move** it through the toolbox's `/place`, which is a rename inside the one mount and
 *    therefore genuinely atomic. Never `renameSync` here: the process that owns the library
 *    is the container, and a half-moved file is the one outcome worse than a misfiled one;
 *  - **update the database** — `library_tracks.path`, the album's `folder` and `cover_path` —
 *    because a row whose path no longer points at the file is worse than no relocate at all;
 *  - **ask Navidrome to rescan**, since it keys on path and would otherwise show the album
 *    twice until its own nightly scan.
 *
 * Two refusals, both deliberate:
 *
 *  - a destination that already exists is **skipped**, never overwritten. `on_exists` is not
 *    plumbed through: this operation exists to tidy names, and "tidy" must never mean "lose a
 *    file";
 *  - a track with no metadata document cannot be rendered, so it is reported as `blocked`
 *    rather than guessed at from its filename.
 *
 * **Navidrome identifies a file by its path**, so a move loses that track's play count and
 * its favourites. That warning is the caller's to show — the CLI prints it, the Console puts
 * it in the button's callout, and the MCP tool says it in its description. The dry run exists
 * so it can be shown over a concrete list.
 */
import { existsSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import {
  renderAlbumFolder,
  renderPathTemplate,
  type DiscMode,
  type SanitizeMode,
  type TemplateOptions,
  type TrackDocument,
  type TrackPathInput,
} from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  libraryAlbums,
  libraryTracks,
  metadataDocuments,
  type LibraryTrack,
} from "#/server/db/schema/index.ts";
import { containerPath, hostPath, type PathMap } from "#/server/paths.ts";
import { emit } from "#/server/services/events.ts";
import { resolvePaths } from "#/server/services/jobs/context.ts";
import { requestRescan } from "#/server/services/navidrome.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import { toolbox as defaultToolbox, type ToolboxClient } from "#/server/toolbox/client.ts";

/* ------------------------------------------------------------------ */
/* rendering one track                                                 */
/* ------------------------------------------------------------------ */

function text(document: TrackDocument, field: string): string | null {
  const value = document.fields[field]?.value;
  return typeof value === "string" && value !== "" ? value : null;
}

function number(document: TrackDocument, field: string): number | null {
  const value = document.fields[field]?.value;
  if (typeof value === "number") return value;
  if (typeof value !== "string") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The template input for a *library* row.
 *
 * `place.pathInputFor` takes an `ImportTrack` and cannot be reused; the shape is the same and
 * the fallbacks differ — here the library row itself is the fallback, because it is the thing
 * that was actually written.
 */
export function pathInputForLibraryTrack(
  document: TrackDocument | null,
  track: LibraryTrack,
  extension: string,
): TrackPathInput | null {
  if (document === null) return null;
  const year = text(document, "date")?.slice(0, 4) ?? text(document, "originaldate")?.slice(0, 4);
  const discs = number(document, "totaldiscs");
  const disc = number(document, "discnumber") ?? track.discNumber;
  return {
    albumArtist: text(document, "albumartist") ?? text(document, "artist") ?? "Unknown Artist",
    album: text(document, "album") ?? "Unknown Album",
    ...(year === undefined || year === "" ? {} : { year }),
    ...(disc === null ? {} : { discNumber: disc }),
    ...(discs === null ? {} : { totalDiscs: discs }),
    trackNumber: number(document, "tracknumber") ?? track.trackNumber ?? 1,
    title: text(document, "title") ?? track.title,
    extension,
  };
}

export function templateOptions(settings: Settings): TemplateOptions {
  return {
    mode: settings.sanitizeMode as SanitizeMode,
    maxSegmentLength: settings.maxSegmentLength,
    discMode: settings.discMode as DiscMode,
  };
}

/* ------------------------------------------------------------------ */
/* the plan                                                            */
/* ------------------------------------------------------------------ */

/** Why a track cannot be moved, when it cannot. `null` means it can. */
export type RelocateBlock = "no-document" | "missing-file" | "destination-taken";

export interface RelocateMove {
  readonly libraryTrackId: string;
  readonly albumId: string | null;
  readonly from: string;
  /** Where the template says it belongs. Equal to `from` for a file already in place. */
  readonly to: string;
  readonly folder: string | null;
  readonly blocked: RelocateBlock | null;
}

export interface RelocatePlan {
  readonly template: string;
  readonly scanned: number;
  /** Files whose path already matches the template. Nothing to do for these. */
  readonly inPlace: number;
  /** The moves that would happen. `blocked` entries are **not** in here. */
  readonly moves: readonly RelocateMove[];
  /** Files off-template that something prevents moving, with the reason. */
  readonly blocked: readonly RelocateMove[];
}

export interface RelocateOptions {
  readonly db?: Database;
  readonly settings?: Settings;
  readonly toolbox?: ToolboxClient;
  readonly paths?: PathMap;
  /** Restrict to one album. Omit for the whole library. */
  readonly albumId?: string | null;
  /** Cap the plan. The count is still over everything scanned. */
  readonly limit?: number;
}

async function documentsOf(
  trackIds: readonly string[],
  db: Database,
): Promise<Map<string, TrackDocument>> {
  if (trackIds.length === 0) return new Map();
  const rows = await db
    .select()
    .from(metadataDocuments)
    .where(inArray(metadataDocuments.libraryTrackId, [...trackIds]));
  const out = new Map<string, TrackDocument>();
  for (const row of rows) {
    if (row.libraryTrackId === null) continue;
    out.set(row.libraryTrackId, row.document as unknown as TrackDocument);
  }
  return out;
}

/**
 * What a relocate *would* do. Pure reads plus one `existsSync` per row — no toolbox call, so
 * the Quality page can afford to run it for its counter.
 */
export async function planRelocate(options: RelocateOptions = {}): Promise<RelocatePlan> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const paths = options.paths ?? resolvePaths(settings);
  const render = templateOptions(settings);

  const tracks =
    options.albumId === undefined || options.albumId === null
      ? await db.select().from(libraryTracks).orderBy(libraryTracks.path)
      : await db
          .select()
          .from(libraryTracks)
          .where(eq(libraryTracks.albumId, options.albumId))
          .orderBy(libraryTracks.path);

  const documents = await documentsOf(
    tracks.map((track) => track.id),
    db,
  );

  const moves: RelocateMove[] = [];
  const blocked: RelocateMove[] = [];
  let inPlace = 0;

  /* Destinations claimed earlier in this same plan, so two rows cannot both target one path. */
  const claimed = new Set<string>();

  for (const track of tracks) {
    const extension = track.path.split(".").pop() ?? "opus";
    const input = pathInputForLibraryTrack(documents.get(track.id) ?? null, track, extension);
    if (input === null) {
      blocked.push({
        libraryTrackId: track.id,
        albumId: track.albumId,
        from: track.path,
        to: track.path,
        folder: null,
        blocked: "no-document",
      });
      continue;
    }

    const to = renderPathTemplate(settings.pathTemplate, input, render);
    if (to === track.path) {
      inPlace += 1;
      continue;
    }

    const move: RelocateMove = {
      libraryTrackId: track.id,
      albumId: track.albumId,
      from: track.path,
      to,
      folder: renderAlbumFolder(settings.pathTemplate, input, render),
      blocked: null,
    };

    if (!existsSync(hostPath(paths, track.path))) {
      blocked.push({ ...move, blocked: "missing-file" });
      continue;
    }
    if (claimed.has(to) || existsSync(hostPath(paths, to))) {
      blocked.push({ ...move, blocked: "destination-taken" });
      continue;
    }
    claimed.add(to);
    moves.push(move);
  }

  return {
    template: settings.pathTemplate,
    scanned: tracks.length,
    inPlace,
    moves: options.limit === undefined ? moves : moves.slice(0, options.limit),
    blocked: options.limit === undefined ? blocked : blocked.slice(0, options.limit),
  };
}

/** How many files sit off-template. The number the Quality page's button carries. */
export async function countOffTemplate(options: RelocateOptions = {}): Promise<number> {
  const plan = await planRelocate(options);
  return plan.moves.length + plan.blocked.filter((entry) => entry.blocked !== "no-document").length;
}

/* ------------------------------------------------------------------ */
/* doing it                                                            */
/* ------------------------------------------------------------------ */

export interface RelocateFailure {
  readonly path: string;
  readonly code: string;
  readonly message: string;
}

export interface RelocateReport {
  readonly dryRun: boolean;
  readonly template: string;
  readonly scanned: number;
  readonly inPlace: number;
  readonly planned: number;
  readonly moved: number;
  readonly skipped: number;
  readonly failed: number;
  readonly moves: readonly { from: string; to: string }[];
  readonly blocked: readonly { path: string; reason: RelocateBlock }[];
  readonly errors: readonly RelocateFailure[];
  /** What Navidrome said when asked to rescan. `null` when nothing moved. */
  readonly rescan: { started: boolean; error: string | null } | null;
}

/** How many `{from, to}` pairs a report carries. A five-thousand-file library is not a page. */
const SAMPLE = 50;

export async function relocate(
  options: RelocateOptions & { dryRun?: boolean; rescan?: boolean } = {},
): Promise<RelocateReport> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const paths = options.paths ?? resolvePaths(settings);
  const box = options.toolbox ?? defaultToolbox();
  const dryRun = options.dryRun ?? true;

  const plan = await planRelocate({ ...options, db, settings, paths });

  const base = {
    dryRun,
    template: plan.template,
    scanned: plan.scanned,
    inPlace: plan.inPlace,
    planned: plan.moves.length,
    blocked: plan.blocked.map((entry) => ({
      path: entry.from,
      reason: entry.blocked ?? ("no-document" as const),
    })),
  };

  if (dryRun) {
    return {
      ...base,
      moved: 0,
      skipped: 0,
      failed: 0,
      moves: plan.moves.slice(0, SAMPLE).map((move) => ({ from: move.from, to: move.to })),
      errors: [],
      rescan: null,
    };
  }

  const done: { from: string; to: string }[] = [];
  const errors: RelocateFailure[] = [];
  let skipped = 0;
  const foldersByAlbum = new Map<string, string>();

  for (const move of plan.moves) {
    try {
      const result = await box.place({
        src: containerPath(paths, move.from),
        dest: containerPath(paths, move.to),
        // Never `overwrite`: this operation tidies names and must not be able to lose a file.
        onExists: "skip",
      });
      if (!result.moved) {
        skipped += 1;
        continue;
      }
      await db
        .update(libraryTracks)
        .set({ path: move.to, updatedAt: new Date() })
        .where(eq(libraryTracks.id, move.libraryTrackId));
      if (move.albumId !== null && move.folder !== null) {
        foldersByAlbum.set(move.albumId, move.folder);
      }
      done.push({ from: move.from, to: move.to });
    } catch (error) {
      const failure = MMError.from(error);
      errors.push({ path: move.from, code: failure.code, message: failure.message });
    }
  }

  /* The album row follows its tracks: a folder that no longer exists is a broken cover path. */
  for (const [albumId, folder] of foldersByAlbum) {
    const cover = `${folder}/cover.jpg`;
    await db
      .update(libraryAlbums)
      .set({
        folder,
        ...(existsSync(hostPath(paths, cover)) ? { coverPath: cover } : {}),
        updatedAt: new Date(),
      })
      .where(eq(libraryAlbums.id, albumId));
  }

  let rescan: { started: boolean; error: string | null } | null = null;
  if (done.length > 0 && options.rescan !== false) {
    // Navidrome keys on path: without this the album appears twice until its own nightly scan.
    const outcome = await requestRescan({ db, settings });
    rescan = { started: outcome.started, error: outcome.error };
  }

  if (done.length > 0 || errors.length > 0) {
    await emit(
      {
        type: "library.relocated",
        level: errors.length > 0 ? "warn" : "info",
        message: `Relocated ${String(done.length)} file(s) to the current template.`,
        data: { moved: done.length, skipped, failed: errors.length, template: plan.template },
      },
      db,
    );
  }

  return {
    ...base,
    moved: done.length,
    skipped,
    failed: errors.length,
    moves: done.slice(0, SAMPLE),
    errors: errors.slice(0, SAMPLE),
    rescan,
  };
}
