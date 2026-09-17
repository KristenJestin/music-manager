/**
 * The background re-tag (`docs/03-metadonnees.md` §8).
 *
 * §8 is the promise this whole architecture exists to make good on: *the database is the
 * source of truth, files are a regenerable projection of it*. If that is true, then finding
 * out six months later that two fields were forgotten costs a re-projection, not a
 * re-download. This service is the re-projection.
 *
 * One file, one pass:
 *
 *   1. **rebuild the document, offline.** `documents.rebuild` reads the raw source cache and
 *      nothing else — §8's "no network" is enforced rather than intended: `offline: true`
 *      makes a cache miss an error instead of an HTTP call.
 *   2. **project it** into the format the file actually is (Vorbis for `.opus`/`.flac`, ID3
 *      for `.mp3`, MP4 atoms for `.m4a`). The tag map owns the names; the toolbox owns the
 *      encoding, exactly as in the `tag` step.
 *   3. **read the file back** through the toolbox's `/probe` and diff the two. This is what
 *      makes the dry run meaningful: the diff is against *what is in the file*, not against
 *      what we believe we wrote.
 *   4. **write**, unless this is a dry run — `clear: true`, so the result is the projection
 *      and not the union of two of them — refresh the `.lrc` sidecar, and stamp the new
 *      schema version on the document and on the library row.
 *
 * The audio stream is never touched: mutagen rewrites the tag block in place.
 *
 * **A dry run keeps its diffs.** That is the point of it. You read them, and *then* you press
 * the button. The real run re-projects rather than "applying" the stored diff, because between
 * the two the raw cache may have grown — and re-projecting costs nothing.
 *
 * **Work is done in batches.** One queue job re-tags `retagBatchSize` files and then puts
 * itself back on the queue. A library-wide re-tag is therefore interruptible, cancellable and
 * visible: the run row carries its own counters and every batch emits a journal line, so the
 * Console's progress bar is reading the same rows the CLI prints.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { and, desc, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import {
  applyAlbumScopeTo,
  formatProjection,
  projectDocument,
  trackCompleteness,
  type AlbumScopeResolution,
  type ProjectedTag,
  type TagFormat,
  type TrackDocument,
} from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  libraryAlbums,
  libraryTracks,
  metadataDocuments,
  retagDiffs,
  retagRuns,
  type LibraryTrack,
  type RetagRun,
  type RetagScope,
  type RetagSelection,
  type RetagTagChange,
  type RetagTrigger,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { containerPath, hostPath, type PathMap } from "#/server/paths.ts";
import { resolvePaths } from "#/server/services/jobs/context.ts";
import { emit } from "#/server/services/events.ts";
import { albumScopeResolver } from "#/server/services/album-scope.ts";
import { rebuild as rebuildDocument } from "#/server/services/documents.ts";
import { lyricsOf } from "#/server/services/jobs/steps/tag.ts";
import { requestRescan } from "#/server/services/navidrome.ts";
import { withoutProjection } from "#/server/services/projection.ts";
import { tracksAdrift, tracksBehindSchema } from "#/server/services/quality.ts";
import { effectiveSchemaVersion } from "#/server/services/schema-version.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import {
  toolbox as defaultToolbox,
  type Tag,
  type ToolboxClient,
} from "#/server/toolbox/client.ts";

/* ------------------------------------------------------------------ */
/* the format a file actually is                                       */
/* ------------------------------------------------------------------ */

const BY_EXTENSION: Readonly<Record<string, TagFormat>> = Object.freeze({
  opus: "vorbis",
  ogg: "vorbis",
  oga: "vorbis",
  flac: "vorbis",
  mp3: "id3v24",
  m4a: "mp4",
  mp4: "mp4",
  aac: "mp4",
  alac: "mp4",
});

/**
 * Which projection a path needs.
 *
 * A guess is not acceptable here: projecting Vorbis names into an MP3 would write a pile of
 * `TXXX` frames nothing reads, and the file would still be "up to date" afterwards. An
 * unknown extension is an error, and the diff row says so.
 */
export function formatOf(path: string): TagFormat {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const format = BY_EXTENSION[extension];
  if (format === undefined) {
    throw new MMError("INVALID_INPUT", `No tag format is known for a ".${extension}" file.`, {
      hint: "The tag map covers Vorbis (opus, flac), ID3v2.4 (mp3) and MP4 atoms (m4a).",
    });
  }
  return format;
}

/* ------------------------------------------------------------------ */
/* the diff                                                            */
/* ------------------------------------------------------------------ */

/**
 * Keys `ffprobe` reports that are not tags of ours.
 *
 * Two families: what the container itself records (the encoder, the brands, the stream
 * handler) and what ffprobe synthesises. Listing them explicitly rather than filtering by
 * "not in the tag map" is deliberate — a key we do not recognise and did not put there is
 * exactly the interesting case, and it should show up as `removed` so somebody looks at it.
 */
const NOT_OURS = new Set([
  "ENCODER",
  "ENCODED_BY",
  "COMPATIBLE_BRANDS",
  "MAJOR_BRAND",
  "MINOR_VERSION",
  "HANDLER_NAME",
  "VENDOR_ID",
  "DURATION",
  "TLEN",
  "METADATA_BLOCK_PICTURE",
  "COVERART",
  "COVERARTMIME",
]);

/**
 * Keys `ffprobe` renames on its way out.
 *
 * ffmpeg's Ogg/Vorbis demuxer runs the comment block through `ff_vorbiscomment_metadata_conv`
 * before reporting it, which maps three of our keys onto ffmpeg's own generic metadata names.
 * The file really does contain `ALBUMARTIST`; `/probe` really does say `ALBUM_ARTIST`.
 *
 * Without this table every single file of every album showed three phantom additions and
 * three phantom removals on every dry run — which is precisely the kind of lie a diff must not
 * tell, because a diff nobody can trust is worse than no diff at all. It was found by running
 * `mm retag --dry-run` over a freshly tagged album and getting "14 changed" for files that had
 * been written minutes earlier.
 *
 * Left-hand side is the key **we write**; the list is what ffprobe may call it instead.
 */
const PROBE_ALIASES: Readonly<Record<string, readonly string[]>> = {
  ALBUMARTIST: ["ALBUM_ARTIST"],
  TRACKNUMBER: ["TRACK"],
  DISCNUMBER: ["DISC"],
};

export interface ProjectionDiff {
  readonly added: RetagTagChange[];
  readonly removed: RetagTagChange[];
  readonly changed: RetagTagChange[];
  readonly unchanged: number;
}

/** True when the diff would leave the file exactly as it is. */
export function isNoop(diff: ProjectionDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

/**
 * Compare a projection with what is embedded in the file.
 *
 * `ffprobe` reports one string per key, so a multi-valued Vorbis field (`ARTISTS`, `GENRE`,
 * `PERFORMER`) comes back as whatever the container joined it into. The projection's values
 * for one key are therefore compared *joined*, with the separator ffmpeg itself uses — which
 * makes the comparison honest for the common case and, in the rare case where a container
 * disagrees about the separator, reports a difference rather than hiding one. The re-tag
 * writes the values separately regardless: only the *diff* is approximate here, never the
 * write.
 */
export function diffProjection(
  projected: readonly ProjectedTag[],
  embedded: Readonly<Record<string, string>>,
): ProjectionDiff {
  const wanted = new Map<string, { values: string[]; field: string }>();
  for (const tag of projected) {
    const key = tag.key.toUpperCase();
    const held = wanted.get(key);
    if (held === undefined) wanted.set(key, { values: [tag.value], field: tag.field });
    else held.values.push(tag.value);
  }

  const present = new Map<string, string>();
  for (const [key, value] of Object.entries(embedded)) present.set(key.toUpperCase(), value);

  const added: RetagTagChange[] = [];
  const changed: RetagTagChange[] = [];
  const removed: RetagTagChange[] = [];
  /** Probe keys already accounted for, so the "removed" pass does not report them twice. */
  const consumed = new Set<string>();
  let unchanged = 0;

  /** The probe's value for one of our keys, under whatever name it chose to report it. */
  const embeddedValue = (key: string): string | undefined => {
    const direct = present.get(key);
    if (direct !== undefined) {
      consumed.add(key);
      return direct;
    }
    for (const alias of PROBE_ALIASES[key] ?? []) {
      // An alias that we also write ourselves is not an alias, it is a different tag.
      if (wanted.has(alias)) continue;
      const value = present.get(alias);
      if (value !== undefined) {
        consumed.add(alias);
        return value;
      }
    }
    return undefined;
  };

  for (const [key, { values, field }] of wanted) {
    const after = values.join("; ");
    const before = embeddedValue(key);
    if (before === undefined) {
      added.push({ key, field, after });
    } else if (normalise(before) === normalise(after)) {
      unchanged += 1;
    } else {
      changed.push({ key, field, before, after });
    }
  }

  for (const [key, before] of present) {
    if (wanted.has(key) || consumed.has(key) || NOT_OURS.has(key)) continue;
    removed.push({ key, before });
  }

  const order = (a: RetagTagChange, b: RetagTagChange): number => a.key.localeCompare(b.key);
  return {
    added: added.sort(order),
    removed: removed.sort(order),
    changed: changed.sort(order),
    unchanged,
  };
}

/**
 * Compare values the way a tag reader would.
 *
 * Trims, collapses runs of whitespace, and treats the two joiners containers use for a
 * multi-valued frame as the same joiner. It does **not** case-fold: `Daft Punk` and `DAFT
 * PUNK` are a real difference and hiding it would defeat the point of the diff.
 */
function normalise(value: string): string {
  return value
    .replace(/\s*[;/]\s*/g, "; ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The same hash `tag` stores, so a re-tag and an import agree on "unchanged". */
export function hashProjection(tags: readonly ProjectedTag[]): string {
  return createHash("sha256").update(formatProjection(tags)).digest("hex").slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* planning a run                                                      */
/* ------------------------------------------------------------------ */

export interface PlanOptions {
  readonly db?: Database;
  readonly settings?: Settings;
  readonly scope: RetagScope;
  /** An album id for `album`, a library-track id for `track`, absent for `library`. */
  readonly targetId?: string | null;
  /**
   * Which files inside the scope. See `RETAG_SELECTIONS`.
   *
   * `adrift` is the one that is about *values*: the files that disagree with the database.
   * Nothing selected `behind` before it existed, so a re-matched album — every file of it
   * carrying the current schema version and the previous edition's ids — was unreachable from
   * `mm retag`, from the Quality page and from the REST route alike, and the only report that
   * knew was a full library scan.
   */
  readonly selection?: RetagSelection;
  /**
   * The old two-way spelling of `selection`, kept so every existing caller still means what it
   * meant: `true` (the default) is `behind`, `false` is `all`. `selection` wins when both are
   * given.
   */
  readonly onlyBehind?: boolean;
}

/** `selection`, defaulted, with the legacy `onlyBehind` folded into it. */
export function selectionOf(options: {
  selection?: RetagSelection;
  onlyBehind?: boolean;
}): RetagSelection {
  if (options.selection !== undefined) return options.selection;
  return options.onlyBehind === false ? "all" : "behind";
}

/** Which files a run would touch, in a stable order. */
export async function planRetag(options: PlanOptions): Promise<LibraryTrack[]> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const selection = selectionOf(options);

  if (selection === "adrift") {
    const scoped = await tracksAdrift({
      db,
      ...(options.scope === "album" ? { albumId: options.targetId ?? "" } : {}),
      ...(options.scope === "track" ? { trackId: options.targetId ?? "" } : {}),
    });
    return scoped.map((entry) => entry.track);
  }

  if (options.scope === "track") {
    const id = options.targetId ?? "";
    const [row] = await db.select().from(libraryTracks).where(eq(libraryTracks.id, id)).limit(1);
    if (row === undefined) throw new MMError("NOT_FOUND", `No library track with id ${id}.`);
    return [row];
  }

  if (options.scope === "album") {
    const id = options.targetId ?? "";
    if (selection === "behind") return await tracksBehindSchema({ db, settings, albumId: id });
    return await db
      .select()
      .from(libraryTracks)
      .where(eq(libraryTracks.albumId, id))
      .orderBy(libraryTracks.discNumber, libraryTracks.trackNumber);
  }

  if (selection === "behind") return await tracksBehindSchema({ db, settings });
  return await db
    .select()
    .from(libraryTracks)
    .orderBy(libraryTracks.albumId, libraryTracks.discNumber, libraryTracks.trackNumber);
}

export interface CreateRunOptions extends PlanOptions {
  readonly dryRun?: boolean;
  readonly trigger?: RetagTrigger;
}

/**
 * Open a run: count what it will touch, write the row, say so in the journal.
 *
 * The total is fixed here rather than recounted per batch. A file that stops being behind
 * while the run is in flight (because this run just fixed it) must not shrink the denominator
 * under a progress bar somebody is watching.
 *
 * **A run with nothing in scope is born `done`.** Nobody ever queues it — every caller that
 * finds `total === 0` returns straight away without an `enqueueRetagRun` — so a row left
 * `pending` here would stay `pending` forever, and a careful caller polling "an up-to-date
 * library dry run" a hundred times would leave a hundred zombies behind. There is nothing to
 * batch and nothing to cancel, so `done` is simply the truth on arrival.
 */
export async function createRun(options: CreateRunOptions): Promise<RetagRun> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const targets = await planRetag({ ...options, db, settings });
  const id = newId("retagRun");
  const empty = targets.length === 0;
  const now = new Date();

  const [row] = await db
    .insert(retagRuns)
    .values({
      id,
      scope: options.scope,
      targetId: options.targetId ?? null,
      selection: selectionOf(options),
      trigger: options.trigger ?? "manual",
      dryRun: options.dryRun ?? false,
      status: empty ? "done" : "pending",
      schemaVersion: effectiveSchemaVersion(settings),
      total: targets.length,
      ...(empty ? { startedAt: now, finishedAt: now } : {}),
    })
    .returning();

  if (row === undefined) throw new MMError("INTERNAL", "The re-tag run was not created.");

  await emit(
    {
      type: empty ? "retag.done" : "retag.queued",
      message: empty
        ? `${options.dryRun === true ? "Dry run" : "Re-tag"}: ${emptyReason(selectionOf(options))}`
        : `${options.dryRun === true ? "Dry run" : "Re-tag"} queued: ${String(targets.length)} file(s), projection v${String(row.schemaVersion)}.`,
      data: { runId: row.id, scope: row.scope, total: row.total, dryRun: row.dryRun },
    },
    db,
  );

  return row;
}

/**
 * What an empty run actually found out, which is not what it used to say.
 *
 * "Nothing in scope is behind the projection" was printed for `behind`, and it is a claim
 * about *values* that `behind` has no means of making — it compares a schema version. The owner
 * read it on twelve Birdy files that carried the previous edition's ids and reasonably
 * concluded the re-tag was broken; what was broken was the sentence. Each selection now reports
 * the question it actually asked, and `behind` says which one would have answered differently.
 */
export function emptyReason(selection: RetagSelection): string {
  if (selection === "adrift") return "every file in scope already matches the database.";
  if (selection === "all") return "there is no file in scope.";
  return (
    "no file in scope was written by an older projection version. " +
    "That is a question about `MUSICMANAGER_TAGSCHEMA`, not about values — " +
    "use the `adrift` selection (`mm retag --adrift`) to find files whose tags disagree " +
    "with the database."
  );
}

/**
 * The sentence a run that finished without touching a single file owes the person who ran it.
 *
 * `createRun` says `emptyReason` when the *plan* is empty, and that path was fine. This is the
 * other one, and it was silent: a run that plans N files and then selects none of them on its
 * first batch — because `scopeTargets` re-derives the set, and the world may have moved, or the
 * selection may never have been able to see what the caller meant — finished `done` and printed
 * `done: 0/1 file(s), 0 changed, 0 failed`. Which reads as success. "0 changed" is not a
 * finding, it is the absence of one, and a run reporting it without saying *why it looked at
 * nothing* trains the operator to believe a repair happened.
 *
 * `null` the moment one file was processed — a run that looked at four files and changed none of
 * them genuinely did its job, and `0 changed` is then the whole truth.
 */
export function emptyRunNote(
  run: Pick<RetagRun, "done" | "dryRun" | "selection" | "status">,
): string | null {
  if (run.done > 0) return null;
  // A run somebody stopped looked at nothing for a reason of its own, and it is not this one.
  if (run.status !== "done") return null;
  return `No file was selected — ${emptyReason(run.selection)}`;
}

/**
 * Sweep away pre-existing `pending` runs with nothing in scope.
 *
 * `createRun` now closes an empty run on arrival (above), but a run opened before that fix
 * shipped is still sitting there `pending` — and would sit there forever, since nothing ever
 * queues a run with `total = 0`. Called once at worker start, which is early enough that
 * nothing has looked at these rows as "in flight" yet.
 */
export async function cleanupEmptyRetagRuns(db: Database = defaultDb()): Promise<number> {
  const rows = await db
    .update(retagRuns)
    .set({
      status: "done",
      startedAt: sql`coalesce(${retagRuns.startedAt}, now())`,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(and(eq(retagRuns.status, "pending"), eq(retagRuns.total, 0)))
    .returning({ id: retagRuns.id });
  return rows.length;
}

/* ------------------------------------------------------------------ */
/* running one file                                                    */
/* ------------------------------------------------------------------ */

export interface FileContext {
  readonly db: Database;
  readonly settings: Settings;
  readonly toolbox: ToolboxClient;
  readonly paths: PathMap;
  readonly schemaVersion: number;
  readonly dryRun: boolean;
  readonly signal?: AbortSignal;
  /**
   * The album-scope resolution of the album a file belongs to (`album-scope.service`).
   *
   * Optional so a caller can re-tag one file without an album around it, but `runBatch`
   * always supplies it: without it a re-tag would faithfully re-project the *recording*'s
   * genre and undo the unification the `tag` step wrote.
   */
  readonly albumScope?: (albumId: string | null) => Promise<AlbumScopeResolution>;
}

export interface FileOutcome {
  readonly path: string;
  readonly diff: ProjectionDiff;
  readonly wrote: boolean;
  readonly schemaBefore: number | null;
  readonly schemaAfter: number | null;
  readonly error: MMError | null;
}

/**
 * Re-project one file.
 *
 * Every failure is *this file's* failure: it is recorded on the diff row and the run carries
 * on. A library-wide re-tag that stopped on the first file with a missing cache entry would
 * be useless, and the whole point of keeping a row per file is that "which ones did not work"
 * is a question with an answer.
 */
export async function retagOne(ctx: FileContext, track: LibraryTrack): Promise<FileOutcome> {
  const empty: ProjectionDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  const before = track.tagSchemaVersion;

  try {
    if (track.importTrackId === null) {
      throw new MMError(
        "NOT_FOUND",
        `${track.path} was not produced by an import, so there are no sources to rebuild it from.`,
        {
          hint: "Files found by the library scan are adopted in a later phase.",
          action: "Import it instead",
        },
      );
    }

    const absolute = hostPath(ctx.paths, track.path);
    if (!existsSync(absolute)) {
      throw new MMError("NOT_FOUND", `${track.path} is not on disk.`, {
        hint: "The library scan reports missing files; a re-download restores one.",
        action: "Re-download",
      });
    }

    const format = formatOf(track.path);

    /*
     * ---- 1 · the document, from the raw cache, offline ----
     *
     * `persist: false`, and it matters twice. A **dry run** must write nothing at all, and the
     * builder's own persistence is a write: it stored the per-track rebuild — the recording's
     * genre, this video's ℗ line — over the album-scope value the `tag` step had put there, so
     * reading the diff undid the unification without touching a file. And on a real run the
     * document that belongs in the row is the one that was *projected*, which `stamp` writes a
     * few lines below; persisting a different one first is at best redundant.
     */
    const built = await rebuildDocument(track.importTrackId, {
      db: ctx.db,
      settings: ctx.settings,
      offline: true,
      persist: false,
      ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
    });
    if (built.requests > 0) {
      // §8 says "no network". If the builder reached out, that is a defect, not a warning.
      throw new MMError(
        "INTERNAL",
        `Rebuilding ${track.path} made ${String(built.requests)} outgoing request(s); a re-tag must be offline.`,
      );
    }

    /*
     * ---- 2 · the album's value for the album-scope fields, then the projection ----
     *
     * The rebuild above is per track, so `GENRE` comes back from the *recording* and
     * `COPYRIGHT` from *this* video's ℗ line. Both are `albumScope: true`, and writing them
     * per track is what made an album diverge from itself. The resolution is the album's, and
     * it is a pure function of the raw cache — so this file gets the same answer whichever
     * batch it lands in.
     */
    const scope = await ctx.albumScope?.(track.albumId);
    const document =
      scope === undefined ? built.document : applyAlbumScopeTo(built.document, scope);
    const projected = projectDocument(document, format);

    /* ---- 3 · what the file actually holds ---- */
    const probe = await ctx.toolbox.probe(containerPath(ctx.paths, track.path));
    const diff = diffProjection(projected, probe.tags ?? {});

    if (ctx.dryRun) {
      return {
        path: track.path,
        diff,
        wrote: false,
        schemaBefore: before,
        schemaAfter: null,
        error: null,
      };
    }

    /* ---- 4 · write, refresh the sidecar, stamp the version ---- */
    const tags: Tag[] = projected.map((tag) => ({ key: tag.key, value: tag.value }));
    const lrc = lyricsOf(document);
    await ctx.toolbox.tag({
      path: containerPath(ctx.paths, track.path),
      format: "auto",
      tags,
      // Pictures are deliberately not re-sent: re-embedding the artwork would mean fetching
      // it, and §8's re-tag is offline. `clear` does empty the whole tag block — on Ogg the
      // picture *is* a tag — so the toolbox reads the existing pictures first and puts them
      // back (`keep_pictures`, on by default). Sending `pictures: []` therefore keeps the
      // cover; it does not strip it.
      pictures: [],
      lyrics_lrc: lrc,
      sidecar_lrc: false,
      clear: true,
    });

    refreshSidecars(ctx, track, document);

    const hash = hashProjection(projected);
    await stamp(ctx, track, document, hash);

    return {
      path: track.path,
      diff,
      wrote: true,
      schemaBefore: before,
      schemaAfter: ctx.schemaVersion,
      error: null,
    };
  } catch (error) {
    return {
      path: track.path,
      diff: empty,
      wrote: false,
      schemaBefore: before,
      schemaAfter: null,
      error: MMError.from(error),
    };
  }
}

/**
 * Rewrite the sidecars a document owns.
 *
 * Only the `.lrc` here, and only when the setting asks for it: it is generated from the raw
 * cache, so it is free to redo and it is the one sidecar that is *per track*. `cover.jpg` is
 * per album and needs the artwork, which needs the network — the cover picker does that, on
 * purpose and with a person watching.
 */
function refreshSidecars(ctx: FileContext, track: LibraryTrack, document: TrackDocument): void {
  if (!ctx.settings.writeLyricsSidecar) return;
  const lyrics = lyricsOf(document);
  if (lyrics === null) return;
  const target = hostPath(ctx.paths, track.path.replace(/\.[^./]+$/, ".lrc"));
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, lyrics.endsWith("\n") ? lyrics : `${lyrics}\n`, "utf8");
}

/**
 * Record that this file now carries the current projection.
 *
 * Three writes, and all three matter: the document's own `schemaVersion` (so an export or a
 * later rebuild agrees), the `metadata_documents` row (so "documents behind" is right), and
 * the `library_tracks` row (so "files behind" is right — that is the one the Quality page
 * counts, because it is the one that describes a file).
 *
 * The `library_tracks` write also clears `file_drift_at`, and that is what keeps the scan's
 * recorded finding from ageing into a lie. We have just handed the toolbox the whole tag block
 * and it wrote it, so whatever a previous scan read out of this file is no longer in it — and a
 * flag nobody clears is a "175 files adrift" that never goes down however many times you press
 * the button. Only here, on a real write: a dry run never reaches `stamp`, and a `retagOne` that
 * threw does not either, so a file that failed to be repaired stays flagged. Which is right.
 */
async function stamp(
  ctx: FileContext,
  track: LibraryTrack,
  document: TrackDocument,
  hash: string,
): Promise<void> {
  const stamped = { ...document, schemaVersion: ctx.schemaVersion };
  await ctx.db
    .update(metadataDocuments)
    .set({
      document: stamped as unknown as Record<string, unknown>,
      // Re-scored here because the album-scope pass can *fill* a field this track had none of
      // — the album has a genre, this recording had not — and a stale `completeness` would
      // contradict the score the Quality page computes from the document itself.
      completeness: trackCompleteness(stamped).score,
      tagSchemaVersion: ctx.schemaVersion,
      projectionHash: hash,
      updatedAt: new Date(),
    })
    .where(eq(metadataDocuments.libraryTrackId, track.id));

  await ctx.db
    .update(libraryTracks)
    .set({
      tagSchemaVersion: ctx.schemaVersion,
      projectionHash: hash,
      fileDriftAt: null,
      updatedAt: new Date(),
    })
    .where(eq(libraryTracks.id, track.id));
}

/* ------------------------------------------------------------------ */
/* running a batch                                                     */
/* ------------------------------------------------------------------ */

export interface BatchOptions {
  readonly db?: Database;
  readonly settings?: Settings;
  readonly toolbox?: ToolboxClient;
  readonly signal?: AbortSignal;
  /** Override the setting, for the tests. */
  readonly batchSize?: number;
}

export interface BatchResult {
  readonly run: RetagRun;
  readonly processed: number;
  readonly remaining: number;
  readonly finished: boolean;
}

/**
 * Do the next slice of a run.
 *
 * The slice is chosen from the *plan*, minus the files this run has already recorded a diff
 * for. That is what makes a batch restartable: a worker killed mid-run leaves the run row
 * `running` with N diffs, and the next batch simply carries on from N — no cursor to keep, no
 * file re-tagged twice.
 */
export async function runBatch(runId: string, options: BatchOptions = {}): Promise<BatchResult> {
  // A re-tag writes tags; writing tags changes what the file holds; and *that* must not queue
  // another re-tag. Nothing under here goes through `services/projection.ts` today — `retagOne`
  // rebuilds with `persist: false` and `stamp` writes the rows directly — so the wrapper is
  // belt and braces rather than load-bearing, which is exactly when a loop guard is cheap.
  return await withoutProjection(async () => await runBatchInner(runId, options));
}

async function runBatchInner(runId: string, options: BatchOptions): Promise<BatchResult> {
  const db = options.db ?? defaultDb();
  const settings = options.settings ?? (await loadSettings(db));
  const toolbox = options.toolbox ?? defaultToolbox();
  const paths = resolvePaths(settings);
  const batchSize = options.batchSize ?? settings.retagBatchSize;

  const run = await getRun(runId, db);
  if (run === null) throw new MMError("NOT_FOUND", `No re-tag run with id ${runId}.`);
  if (run.status === "cancelled" || run.status === "done" || run.status === "failed") {
    return { run, processed: 0, remaining: 0, finished: true };
  }

  if (run.status === "pending") {
    await db
      .update(retagRuns)
      .set({ status: "running", startedAt: new Date(), updatedAt: new Date() })
      .where(eq(retagRuns.id, run.id));
    await emit(
      {
        type: "retag.started",
        message: `${run.dryRun ? "Dry run" : "Re-tag"} started: ${String(run.total)} file(s) to projection v${String(run.schemaVersion)}.`,
        data: { runId: run.id, total: run.total, dryRun: run.dryRun },
      },
      db,
    );
  }

  /* ---- what is left ---- */
  const scoped = await scopeTargets(run, db, settings);
  const done = await doneIds(run.id, db);
  const pending = scoped.filter((track) => !done.has(track.id));
  const slice = pending.slice(0, batchSize);

  const ctx: FileContext = {
    db,
    settings,
    toolbox,
    paths,
    schemaVersion: run.schemaVersion,
    dryRun: run.dryRun,
    // One resolution per album, computed on first use and reused for every file of the batch.
    albumScope: albumScopeResolver({
      db,
      settings,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  };

  for (const track of slice) {
    if (options.signal?.aborted === true) break;
    const current = await getRun(run.id, db);
    if (current?.status === "cancelled") break;

    const outcome = await retagOne(ctx, track);
    const touched = !isNoop(outcome.diff);

    await db.insert(retagDiffs).values({
      id: newId("retagDiff"),
      runId: run.id,
      libraryTrackId: track.id,
      albumId: track.albumId,
      path: outcome.path,
      added: outcome.diff.added,
      removed: outcome.diff.removed,
      changed: outcome.diff.changed,
      unchanged: outcome.diff.unchanged,
      wrote: outcome.wrote,
      schemaBefore: outcome.schemaBefore,
      schemaAfter: outcome.schemaAfter,
      error: outcome.error === null ? null : outcome.error.toBody(),
    });

    await db
      .update(retagRuns)
      .set({
        done: sql`${retagRuns.done} + 1`,
        changed: sql`${retagRuns.changed} + ${touched && outcome.error === null ? 1 : 0}`,
        failed: sql`${retagRuns.failed} + ${outcome.error === null ? 0 : 1}`,
        updatedAt: new Date(),
      })
      .where(eq(retagRuns.id, run.id));

    await emit(
      {
        importId: track.importId,
        type: "retag.progress",
        level: outcome.error === null ? "info" : "warn",
        message:
          outcome.error !== null
            ? `${track.path}: ${outcome.error.message}`
            : run.dryRun
              ? `${track.path}: ${describeDiff(outcome.diff)} (dry run, nothing written)`
              : `${track.path}: ${describeDiff(outcome.diff)}`,
        // The per-file counts are named `*Tags` so they cannot be mistaken for the run's own
        // `changed`/`failed` counters, which travel under those names on the finish event and
        // which the Console's progress bar reads.
        data: {
          runId: run.id,
          path: track.path,
          addedTags: outcome.diff.added.length,
          removedTags: outcome.diff.removed.length,
          changedTags: outcome.diff.changed.length,
          wrote: outcome.wrote,
        },
      },
      db,
    );
  }

  const remaining = pending.length - slice.length;
  const after = await getRun(run.id, db);
  const cancelled = after?.status === "cancelled";

  if (remaining <= 0 || cancelled) {
    await finish(run.id, cancelled ? "cancelled" : "done", db, settings);
  }

  const final = (await getRun(run.id, db)) ?? run;
  return {
    run: final,
    processed: slice.length,
    remaining: Math.max(0, remaining),
    finished: remaining <= 0 || cancelled,
  };
}

/**
 * The files this run still means, re-derived on every batch.
 *
 * Re-derived rather than remembered because a run is a queue of batches and a worker can die
 * between two of them; the price is that the set has to be recomputed from a world the run is
 * itself changing, and that is what the `stamped` union below is for. A file this run has
 * already written is no longer behind and no longer adrift — it would drop out of the filter,
 * and `remaining` would go wrong under a progress bar somebody is watching.
 *
 * **It reads `run.selection`.** It used to read nothing and assume `behind` for every `library`
 * run, which silently unmade `onlyBehind: false`: `mm retag --all` opened a run over the whole
 * library, `planRetag` returned four thousand files, this function threw every one of them away
 * because none was behind the *schema*, and the run finished `done` with `0/4344` without
 * opening a file. The two bugs compounded — one selection that could not see a value change,
 * and one filter that discarded the selection that could.
 */
async function scopeTargets(
  run: RetagRun,
  db: Database,
  settings: Settings,
): Promise<LibraryTrack[]> {
  const plan = { db, settings, scope: run.scope, targetId: run.targetId } as const;

  let selected: LibraryTrack[];
  if (run.selection === "all") {
    selected = await planRetag({ ...plan, selection: "all" });
  } else if (run.selection === "behind") {
    /*
     * Everything in scope, filtered by the run's **own** schema version rather than the live
     * one: a run opened at v2 must finish at v2 even if somebody bumps the projection to v3
     * halfway through it. `planRetag`'s `behind` reads the current version, so it cannot be
     * used here — this is the one selection whose meaning is frozen at the run row.
     *
     * Except for a `track` scope, where `planRetag` returns the named row for every selection
     * and this must agree with it. **Naming one file is the selection.** Disagreeing here was a
     * bug with the same shape as the `library`/`all` one above and a worse face: `mm retag
     * --track <id>` planned the file, opened a run with `total = 1`, filtered it away because
     * the file carried the current schema version — which a hand-edited file always does — and
     * finished `done: 0/1 file(s), 0 changed`. Success, over an empty set, on the one command
     * whose whole argument was *this file*.
     */
    selected =
      run.scope === "track"
        ? await planRetag({ ...plan, selection: "all" })
        : (await planRetag({ ...plan, selection: "all" })).filter(
            (track) =>
              track.tagSchemaVersion === null || track.tagSchemaVersion < run.schemaVersion,
          );
  } else {
    // Straight from `planRetag`, not scope-wide-then-filtered: a library-wide adrift run would
    // otherwise re-project every document in the library **twice** on every batch of 25.
    selected = await planRetag({ ...plan, selection: "adrift" });
  }
  if (run.selection === "all") return selected;

  /*
   * Files this run has already written are no longer behind and no longer adrift, so they drop
   * out of the selection — and `remaining` would go wrong under a progress bar somebody is
   * watching. Added back by id rather than by re-reading the scope.
   */
  const done = await doneIds(run.id, db);
  if (done.size === 0) return selected;
  const seen = new Set(selected.map((track) => track.id));
  const missing = [...done].filter((id) => !seen.has(id));
  if (missing.length === 0) return selected;
  const stamped = await db.select().from(libraryTracks).where(inArray(libraryTracks.id, missing));
  return [...selected, ...stamped];
}

async function doneIds(runId: string, db: Database): Promise<Set<string>> {
  const rows = await db
    .select({ id: retagDiffs.libraryTrackId })
    .from(retagDiffs)
    .where(eq(retagDiffs.runId, runId));
  return new Set(rows.map((row) => row.id).filter((id): id is string => id !== null));
}

function describeDiff(diff: ProjectionDiff): string {
  if (isNoop(diff)) return "no change";
  const parts = [
    diff.added.length === 0 ? null : `${String(diff.added.length)} added`,
    diff.changed.length === 0 ? null : `${String(diff.changed.length)} changed`,
    diff.removed.length === 0 ? null : `${String(diff.removed.length)} removed`,
  ].filter((part): part is string => part !== null);
  return parts.join(", ");
}

/**
 * A re-tag that actually wrote something leaves Navidrome's index stale until its next scan —
 * exactly the gap `verify`'s own stale-scan note (`services/verify.ts`) exists to name. `relocate`
 * already asks for a scan on every move it makes; a re-tag that touches a required field,
 * especially a schema bump over the whole library, deserves the same courtesy. Only on a real
 * write, and only when something actually changed — a dry run and a no-op run touch nothing on
 * disk for Navidrome to see. Exported so the gating logic is provable without a full pipeline
 * fixture; `requestRescan` itself is `services/navidrome.ts`'s to test.
 */
export async function rescanIfWritten(
  row: Pick<RetagRun, "dryRun" | "changed">,
  status: "done" | "failed" | "cancelled",
  db: Database,
  settings?: Settings,
): Promise<{ started: boolean; error: string | null } | null> {
  if (row.dryRun || row.changed <= 0 || (status !== "done" && status !== "cancelled")) {
    return null;
  }
  const outcome = await requestRescan({ db, ...(settings === undefined ? {} : { settings }) });
  return { started: outcome.started, error: outcome.error };
}

async function finish(
  runId: string,
  status: "done" | "failed" | "cancelled",
  db: Database,
  settings?: Settings,
): Promise<void> {
  const [row] = await db
    .update(retagRuns)
    .set({ status, finishedAt: new Date(), updatedAt: new Date() })
    .where(eq(retagRuns.id, runId))
    .returning();
  if (row === undefined) return;

  const rescan = await rescanIfWritten(row, status, db, settings);

  const counts = `${row.dryRun ? "Dry run" : "Re-tag"} ${status}: ${String(row.done)}/${String(row.total)} file(s), ${String(row.changed)} changed, ${String(row.failed)} failed.`;
  const note = emptyRunNote(row);

  await emit(
    {
      type: status === "done" ? "retag.done" : `retag.${status}`,
      // A run that touched nothing is not an error, and it is not an "info" either: somebody
      // asked for a repair and none happened. `warn` is what puts it in front of them.
      level: status === "done" && note === null ? "info" : "warn",
      message: note === null ? counts : `${counts} ${note}`,
      data: {
        ...(note === null ? {} : { emptyReason: note }),
        runId: row.id,
        done: row.done,
        total: row.total,
        changed: row.changed,
        failed: row.failed,
        dryRun: row.dryRun,
        ...(rescan === null ? {} : { rescan }),
      },
    },
    db,
  );
}

/**
 * Drain a whole run in this process.
 *
 * The worker prefers `runBatch`, so that a long run stays interruptible and the queue keeps
 * breathing. The CLI and the tests want the answer, so they get a loop — with a hard cap on
 * iterations, because a bug that made `remaining` never shrink should stop rather than spin.
 */
export async function runToCompletion(
  runId: string,
  options: BatchOptions = {},
): Promise<RetagRun> {
  let guard = 0;
  for (;;) {
    const result = await runBatch(runId, options);
    if (result.finished) return result.run;
    guard += 1;
    if (guard > 10_000) {
      throw new MMError("INTERNAL", `Re-tag run ${runId} did not make progress.`);
    }
  }
}

/* ------------------------------------------------------------------ */
/* reading runs back                                                   */
/* ------------------------------------------------------------------ */

export async function getRun(id: string, db: Database = defaultDb()): Promise<RetagRun | null> {
  const [row] = await db.select().from(retagRuns).where(eq(retagRuns.id, id)).limit(1);
  return row ?? null;
}

export async function listRuns(
  options: { limit?: number; albumId?: string } = {},
  db: Database = defaultDb(),
): Promise<RetagRun[]> {
  const query = db
    .select()
    .from(retagRuns)
    .orderBy(desc(retagRuns.createdAt))
    .limit(options.limit ?? 20);
  if (options.albumId === undefined) return await query;
  return await db
    .select()
    .from(retagRuns)
    .where(and(eq(retagRuns.scope, "album"), eq(retagRuns.targetId, options.albumId)))
    .orderBy(desc(retagRuns.createdAt))
    .limit(options.limit ?? 20);
}

export interface RunView {
  readonly run: RetagRun;
  /** At most `limit` rows. `totals` describes the whole run, not this slice. */
  readonly diffs: readonly (typeof retagDiffs.$inferSelect)[];
  /**
   * Counted in SQL, over every row of the run.
   *
   * The counts used to be derived from `diffs` by the callers, which had already been cut to
   * `limit` — so `Math.max(0, changedRows.length - limit)` was a subtraction of a number from
   * itself and "how many more are there?" answered `0` on a run with twenty-six hidden diffs.
   * A truncated list must never be the source of its own total.
   */
  readonly totals: {
    /** Rows written for this run so far — one per file processed. */
    readonly rows: number;
    /** Rows carrying an error. */
    readonly failed: number;
    /** Rows with no error and at least one added/removed/changed tag. */
    readonly changed: number;
  };
}

/** One run and the per-file diffs it produced — what the dry-run panel renders. */
export async function runView(
  id: string,
  options: { limit?: number; only?: "errors" | "changed" } = {},
  db: Database = defaultDb(),
): Promise<RunView | null> {
  const run = await getRun(id, db);
  if (run === null) return null;

  /*
   * `only` exists because errors and diffs are two **disjoint** subsets of the same rows.
   * A single slice of `limit` rows split afterwards can be all of one kind, so a lopsided run
   * answered `diff: []` next to a large `moreDiffs` — the counts were right (they are counted
   * in SQL below) and the sample was empty, which reads as a bug in the counting. Asking for
   * each kind separately makes each slice full of what it is for.
   */
  const changed = sql`(
    jsonb_array_length(${retagDiffs.added}) > 0
    or jsonb_array_length(${retagDiffs.removed}) > 0
    or jsonb_array_length(${retagDiffs.changed}) > 0)`;
  const where =
    options.only === "errors"
      ? and(eq(retagDiffs.runId, id), isNotNull(retagDiffs.error))
      : options.only === "changed"
        ? and(eq(retagDiffs.runId, id), isNull(retagDiffs.error), changed)
        : eq(retagDiffs.runId, id);

  const diffs = await db
    .select()
    .from(retagDiffs)
    .where(where)
    .orderBy(retagDiffs.path)
    .limit(options.limit ?? 500);

  // `jsonb_array_length` rather than a second pass in JavaScript: the whole point is that these
  // three numbers are independent of whatever `limit` the caller chose.
  const [counted] = await db
    .select({
      rows: sql<number>`count(*)::int`,
      failed: sql<number>`count(*) filter (where ${retagDiffs.error} is not null)::int`,
      changed: sql<number>`count(*) filter (where ${retagDiffs.error} is null and (
        jsonb_array_length(${retagDiffs.added}) > 0
        or jsonb_array_length(${retagDiffs.removed}) > 0
        or jsonb_array_length(${retagDiffs.changed}) > 0))::int`,
    })
    .from(retagDiffs)
    .where(eq(retagDiffs.runId, id));

  return {
    run,
    diffs,
    totals: {
      rows: counted?.rows ?? 0,
      failed: counted?.failed ?? 0,
      changed: counted?.changed ?? 0,
    },
  };
}

/* ------------------------------------------------------------------ */
/* reading a diff without drowning in it                               */
/* ------------------------------------------------------------------ */

/**
 * How long a tag value may be before a diff abbreviates it.
 *
 * `ACOUSTID_FINGERPRINT` is base64 and the tag map itself calls it "bulky (≈ 2 KB per track)".
 * Twenty-eight of those in one dry run is fifty-six kilobytes of noise in an answer whose job
 * is to be read, and `LYRICS` is worse: a full LRC is unbounded. The value is never truncated
 * on the way *into* a file — only on the way out to a reader.
 */
export const DIFF_VALUE_LIMIT = 120;

/** `"AQADtJQibVHCoNzx…" (2048 chars)` — enough to recognise, never enough to drown in. */
export function abbreviateValue(value: string, limit = DIFF_VALUE_LIMIT): string {
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}… (${String(value.length)} chars)`;
}

/** The same, over one `{key, field, before, after}` row. */
export function abbreviateChange(change: RetagTagChange, limit = DIFF_VALUE_LIMIT): RetagTagChange {
  return {
    ...change,
    ...(change.before === undefined ? {} : { before: abbreviateValue(change.before, limit) }),
    ...(change.after === undefined ? {} : { after: abbreviateValue(change.after, limit) }),
  };
}

/** The run currently in flight, if any. There is at most one that matters at a time. */
export async function activeRun(db: Database = defaultDb()): Promise<RetagRun | null> {
  const [row] = await db
    .select()
    .from(retagRuns)
    .where(inArray(retagRuns.status, ["pending", "running"]))
    .orderBy(desc(retagRuns.createdAt))
    .limit(1);
  return row ?? null;
}

/** Stop a run. The batch in flight finishes its current file and then notices. */
export async function cancelRun(id: string, db: Database = defaultDb()): Promise<RetagRun | null> {
  const [row] = await db
    .update(retagRuns)
    .set({ status: "cancelled", finishedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(retagRuns.id, id), inArray(retagRuns.status, ["pending", "running"])))
    .returning();
  return row ?? null;
}

/* ------------------------------------------------------------------ */
/* the source-refresh trigger (docs/03 §8, cron)                       */
/* ------------------------------------------------------------------ */

/**
 * Albums whose MusicBrainz release has changed upstream since we cached it.
 *
 * The weekly `sources.refresh` cron re-fetches the release entities we hold, and anything
 * whose payload is not byte-identical to the cached one marks its albums for a re-tag. The
 * comparison is on the *payload*, not on `last-updated`: MusicBrainz's own timestamp moves
 * for edits that change nothing we project, and a re-tag nobody needs is still a write to
 * every file of an album.
 */
export async function albumsOfReleases(
  releaseMbids: readonly string[],
  db: Database = defaultDb(),
): Promise<string[]> {
  if (releaseMbids.length === 0) return [];
  const rows = await db
    .select({ id: libraryAlbums.id })
    .from(libraryAlbums)
    .where(inArray(libraryAlbums.releaseMbid, [...releaseMbids]));
  return rows.map((row) => row.id);
}
