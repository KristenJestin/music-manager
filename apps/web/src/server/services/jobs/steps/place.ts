/**
 * Step 7 — `place` (toolbox) and the sidecars.
 *
 * The destination comes from `packages/domain/paths` — `Artiste/Album (Année)/NN Titre.opus`,
 * sanitised for the filesystem the library is served from — and the move itself is the
 * toolbox's `/place`, which is atomic. Navidrome watches this directory: a half-written file
 * appearing in it is a broken track in someone's player, so "atomic" is not a nicety.
 *
 * The sidecars of `docs/03-metadonnees.md` §3 (`.lrc` per track, `cover.jpg` per album) are
 * written by the orchestrator itself, with `node:fs`: it can see the library directly, and a
 * plain file write needs no endpoint. Every path handed to the toolbox is translated to the
 * container's view first (`src/server/paths.ts`).
 *
 * Idempotent: a track already at its destination is left alone, and `library_*` is upserted
 * on the path, so re-running the step twice produces exactly one row.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import {
  renderAlbumFolder,
  renderPathTemplate,
  type DiscMode,
  type SanitizeMode,
  type TemplateOptions,
  type TrackPathInput,
  type TrackDocument,
} from "@mm/domain";
import {
  libraryAlbums,
  libraryTracks,
  metadataDocuments,
  type ImportTrack,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { containerPath, hostPath, toRelative, workFolder } from "#/server/paths.ts";
import { recountAlbum } from "#/server/services/album-counters.ts";
import { getOrFetch } from "#/server/services/cache.ts";
import { writeArtistImageSidecar } from "#/server/services/artist-image.ts";
import type { StepResult } from "../machine.ts";
import { aborted, fileOnDisk, updateTrack, type StepContext } from "../context.ts";

/** States meaning the track has nothing left in the work directory. */
const LEFT_THE_WORK_DIR = new Set(["placed", "done", "skipped"]);

/** Read one document field as a plain string, or `null`. */
function text(document: TrackDocument, field: string): string | null {
  const value = document.fields[field]?.value;
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

function number(document: TrackDocument, field: string): number | null {
  const value = text(document, field);
  if (value === null) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Where a track belongs, from its document.
 *
 * The document is the source of truth (decision 006), so the folder name and the file name
 * are derived from the very values written into the file — a path can never disagree with a
 * tag.
 */
export function pathInputFor(
  document: TrackDocument,
  track: ImportTrack,
  extension: string,
): TrackPathInput {
  const year = text(document, "date")?.slice(0, 4) ?? text(document, "originaldate")?.slice(0, 4);
  const discs = number(document, "totaldiscs");
  const disc = number(document, "discnumber");
  return {
    albumArtist: text(document, "albumartist") ?? text(document, "artist") ?? "Unknown Artist",
    album: text(document, "album") ?? "Unknown Album",
    ...(year === undefined || year === "" ? {} : { year }),
    ...(disc === null ? {} : { discNumber: disc }),
    ...(discs === null ? {} : { totalDiscs: discs }),
    trackNumber: number(document, "tracknumber") ?? track.trackPosition ?? 1,
    title: text(document, "title") ?? track.trackTitle ?? track.sourceTitle,
    extension,
  };
}

async function documentOf(ctx: StepContext, trackId: string): Promise<TrackDocument | null> {
  const [row] = await ctx.db
    .select()
    .from(metadataDocuments)
    .where(eq(metadataDocuments.importTrackId, trackId))
    .limit(1);
  return row === undefined ? null : (row.document as unknown as TrackDocument);
}

/**
 * The step's closing line, and — when a sidecar is missing — why.
 *
 * `13 file(s) placed, 12 sidecar(s) written` is an arithmetic the reader was given no terms
 * for: a track LRCLIB has no synced lyrics for is entirely ordinary, and the message that did
 * not say so made every album with one instrumental look like a partial failure (third MCP
 * test report, minor observations). Pure, so the sentence can be tested without a library.
 */
export function placeMessage(input: {
  placed: number;
  sidecars: number;
  withoutLyrics: readonly string[];
  writeLyricsSidecar: boolean;
}): string {
  const head = `${String(input.placed)} file(s) placed, ${String(input.sidecars)} sidecar(s) written`;
  if (!input.writeLyricsSidecar) return `${head} (\`.lrc\` sidecars are off in Settings)`;
  if (input.withoutLyrics.length === 0) return head;
  const named = input.withoutLyrics.slice(0, 3).join(", ");
  const more = input.withoutLyrics.length > 3 ? ", …" : "";
  return (
    `${head} — no \`.lrc\` for ${String(input.withoutLyrics.length)} track(s) (${named}${more}): ` +
    "LRCLIB has no synced lyrics for them, which is normal and not a failure"
  );
}

/** Create or update the album row this track belongs to, and return its id. */
async function upsertAlbum(
  ctx: StepContext,
  input: TrackPathInput,
  options: TemplateOptions,
  /**
   * The document being placed, read for its `musicbrainz_releasegroupid`.
   *
   * The import row is the first source of that id, but it is not the only one: the document
   * gets it from the release lookup at `tag` time whatever `match` did or did not record. An
   * album whose import row missed it — a supplied mapping under the old code — is therefore
   * repaired the next time one of its tracks is placed, rather than staying wrong for ever.
   */
  document: TrackDocument | null,
): Promise<string> {
  const folder = renderAlbumFolder(ctx.settings.pathTemplate, input, options);
  const [existing] = await ctx.db
    .select()
    .from(libraryAlbums)
    .where(eq(libraryAlbums.folder, folder))
    .limit(1);

  const fromDocument = document?.fields["musicbrainz_releasegroupid"]?.value;
  const releaseGroupMbid =
    ctx.job.releaseGroupMbid ?? (typeof fromDocument === "string" ? fromDocument : null);

  const year = input.year === undefined ? null : Number(input.year);
  if (existing !== undefined) {
    await ctx.db
      .update(libraryAlbums)
      .set({
        releaseMbid: ctx.job.releaseMbid,
        // Never back to `null` from a known value: an album that has a release group keeps it.
        ...(releaseGroupMbid === null ? {} : { releaseGroupMbid }),
        updatedAt: new Date(),
      })
      .where(eq(libraryAlbums.id, existing.id));
    return existing.id;
  }

  /*
   * `onConflictDoUpdate`, not a plain insert.
   *
   * Since `place` runs once per track (decision 147), two tracks of the same album can reach
   * this line at the same moment, both having found no row a millisecond earlier. `folder` is
   * unique, so the loser used to fail the whole import on a duplicate key — the album's own
   * identity racing itself. The upsert is the same statement for both of them, and
   * `returning` gives each the id that actually exists.
   */
  const [row] = await ctx.db
    .insert(libraryAlbums)
    .values({
      id: newId("libraryAlbum"),
      releaseMbid: ctx.job.releaseMbid,
      releaseGroupMbid,
      albumArtist: input.albumArtist,
      title: input.album,
      year: year === null || Number.isNaN(year) ? null : year,
      folder,
    })
    .onConflictDoUpdate({
      target: libraryAlbums.folder,
      set: {
        releaseMbid: ctx.job.releaseMbid,
        ...(releaseGroupMbid === null ? {} : { releaseGroupMbid }),
        updatedAt: new Date(),
      },
    })
    .returning({ id: libraryAlbums.id });
  if (row === undefined) throw new MMError("UNKNOWN", `Could not open the album ${folder}.`);
  return row.id;
}

/**
 * The row this track already has, whatever it is called today.
 *
 * Three lookups, in order of how much they prove:
 *
 *  1. **the path** — the file is literally already there;
 *  2. **(album, recording MBID)** — MusicBrainz's own identity for "this recording, on this
 *     record", and the only one that survives a rename;
 *  3. **(album, disc, track)** — the fallback for an untagged import, which has no MBID.
 *
 * Only the first existed, and that is the whole of bug C in the second MCP test report:
 * changing `pathTemplate` and re-importing renamed every file, so every lookup missed, so
 * every track was inserted a second time. An album of thirteen tracks became twenty-five rows
 * — twelve real and thirteen pointing at files that no longer existed — and four separate
 * features started answering with the wrong number.
 *
 * The third lookup is fenced, because a position is only an identity when nothing better
 * disagrees. A row that already carries a recording MBID **is** identified, by rung 2, and it
 * is not this track unless the two recordings are the same one; matching it on its number
 * anyway would have `place` overwrite one song's row with another song's file, path, title and
 * provenance — and the overwritten file, still on disk, would come back as an orphan. That is
 * a real risk on an album the v1 migration assembled, where the numbering came from v1's
 * folders rather than from a release.
 */
export async function findLibraryTrack(
  ctx: Pick<StepContext, "db">,
  album: string,
  identity: {
    readonly path: string;
    readonly recordingMbid: string | null;
    readonly discNumber: number | null;
    readonly trackNumber: number | null;
  },
): Promise<{ id: string } | null> {
  const [byPath] = await ctx.db
    .select({ id: libraryTracks.id })
    .from(libraryTracks)
    .where(eq(libraryTracks.path, identity.path))
    .limit(1);
  if (byPath !== undefined) return byPath;

  if (identity.recordingMbid !== null && identity.recordingMbid !== "") {
    const [byRecording] = await ctx.db
      .select({ id: libraryTracks.id })
      .from(libraryTracks)
      .where(
        and(
          eq(libraryTracks.albumId, album),
          eq(libraryTracks.recordingMbid, identity.recordingMbid),
        ),
      )
      .limit(1);
    if (byRecording !== undefined) return byRecording;
  }

  if (identity.trackNumber !== null) {
    const [byPosition] = await ctx.db
      .select({ id: libraryTracks.id, recordingMbid: libraryTracks.recordingMbid })
      .from(libraryTracks)
      .where(
        and(
          eq(libraryTracks.albumId, album),
          identity.discNumber === null
            ? isNull(libraryTracks.discNumber)
            : eq(libraryTracks.discNumber, identity.discNumber),
          eq(libraryTracks.trackNumber, identity.trackNumber),
        ),
      )
      .limit(1);
    /*
     * A row that names a *different* recording is a different song on the same number.
     *
     * Only when **both** sides name one, though. A track with no recording MBID is an untagged
     * import, and a position is the only identity it has — refusing the row there would not
     * make a second row, it would make a *rejected* one, because the position index is unique.
     * So the fence is narrow on purpose: two known recordings that disagree.
     */
    const named = (value: string | null): boolean => value !== null && value !== "";
    const claimed =
      byPosition !== undefined &&
      named(byPosition.recordingMbid) &&
      named(identity.recordingMbid) &&
      byPosition.recordingMbid !== identity.recordingMbid;
    if (byPosition !== undefined && !claimed) return { id: byPosition.id };
  }

  return null;
}

async function upsertLibraryTrack(
  ctx: StepContext,
  album: string,
  track: ImportTrack,
  document: TrackDocument,
  relative: string,
  size: number,
): Promise<void> {
  const row = await findLibraryTrack(ctx, album, {
    path: relative,
    recordingMbid: track.recordingMbid,
    discNumber: number(document, "discnumber"),
    trackNumber: number(document, "tracknumber") ?? track.trackPosition,
  });

  const values = {
    albumId: album,
    recordingMbid: track.recordingMbid,
    trackMbid: track.trackMbid,
    title: text(document, "title") ?? track.sourceTitle,
    artist: text(document, "artist"),
    discNumber: number(document, "discnumber"),
    trackNumber: number(document, "tracknumber") ?? track.trackPosition,
    format: relative.slice(relative.lastIndexOf(".") + 1),
    size,
    duration: track.sourceDuration,
    tagSchemaVersion: document.schemaVersion,
    importId: ctx.job.id,
    importTrackId: track.id,
    /*
     * The `tag` step has just written this file and `place` has just moved it here, so any drift
     * a previous scan recorded for a row at this path (a re-import over an album somebody had
     * edited by hand) describes a file that no longer exists. Left set, it would keep the row in
     * `tracksAdrift` until the next scan and put a repair button under a file that is already
     * right. See `library_tracks.file_drift_at`.
     */
    fileDriftAt: null,
    updatedAt: new Date(),
  };

  let libraryTrackId: string;
  if (row === null) {
    // Same race as the album above, one row down: `path` is unique, and two per-track `place`
    // jobs that disagree about who saw the row first must not turn into a duplicate key.
    const [inserted] = await ctx.db
      .insert(libraryTracks)
      .values({ id: newId("libraryTrack"), path: relative, ...values })
      .onConflictDoUpdate({ target: libraryTracks.path, set: values })
      .returning({ id: libraryTracks.id });
    if (inserted === undefined) return;
    libraryTrackId = inserted.id;
  } else {
    libraryTrackId = row.id;
    // `path` is now part of what an update writes: the row was found by identity, so this is
    // the rename that a template change means. It used to be the lookup key and therefore
    // could never be updated — a second row appeared instead.
    await ctx.db
      .update(libraryTracks)
      .set({ ...values, path: relative })
      .where(eq(libraryTracks.id, row.id));
  }

  // The document now describes a file in the library, not one in the work directory.
  await ctx.db
    .update(metadataDocuments)
    .set({ libraryTrackId, updatedAt: new Date() })
    .where(eq(metadataDocuments.importTrackId, track.id));
}

/** `cover.jpg` next to the tracks. Written once per album, from the cached artwork. */
async function writeCover(ctx: StepContext, folder: string, url: string | null): Promise<boolean> {
  if (!ctx.settings.writeCover || url === null) return false;
  const target = hostPath(ctx.paths, `${folder}/cover.jpg`);
  if (existsSync(target)) return false;
  const entry = await getOrFetch(
    "artwork",
    `${url}#${String(ctx.settings.artworkSize)}`,
    async () => {
      const prepared = await ctx.toolbox.prepareArtwork({ url, size: ctx.settings.artworkSize });
      return { data_base64: prepared.data_base64, mime: prepared.mime };
    },
    { db: ctx.db },
  );
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, Buffer.from(entry.data.data_base64, "base64"));
  return true;
}

/** The front-cover URL of a document, for the sidecar. */
function coverUrl(document: TrackDocument): string | null {
  const value = document.fields["front_cover"]?.value;
  if (!Array.isArray(value)) return null;
  const first = value[0];
  if (typeof first !== "object" || first === null) return null;
  const url = (first as { url?: unknown }).url;
  return typeof url === "string" ? url : null;
}

/** Synchronised lyrics, for the `.lrc` sidecar of §3. */
function lyricsText(document: TrackDocument): string | null {
  const held = document.fields["lyrics"]?.value;
  if (typeof held !== "object" || held === null || Array.isArray(held)) return null;
  const value = held as { synced?: string | null; plain?: string | null };
  return value.synced ?? value.plain ?? null;
}

/**
 * Remove the import's work directory — but only once every track has left it.
 *
 * A leftover audio file there is somebody's interrupted download, and deleting it would cost
 * a re-download, which is the one thing this app is built never to do. The toolbox's own
 * dotfile ledger does not count: it belongs to this directory alone.
 */
async function cleanWorkDir(ctx: StepContext): Promise<void> {
  const work = hostPath(ctx.paths, workFolder(ctx.paths, ctx.job.id));
  if (!existsSync(work)) return;
  // `albumTracks`, never `mappedTracks`: this step runs once per track on the pipelined path
  // (decision 147), and asking the *scoped* view whether every track has left would delete the
  // work directory — and the next track's file with it — as soon as the first one was placed.
  const settled = await ctx.albumTracks();
  /*
   * Every read and every removal here is `try`-wrapped, and that is not defensiveness for its
   * own sake: two per-track `place` jobs finish within milliseconds of each other, both see
   * the same last track filed, and both decide the directory is theirs to remove. The loser
   * used to fail its whole import on `ENOENT: scandir` — an import declared broken because
   * something else had already done exactly what it wanted done.
   */
  let leftovers = 0;
  try {
    leftovers = readdirSync(work, { withFileTypes: true }).filter(
      (entry) => entry.isFile() && !entry.name.startsWith("."),
    ).length;
  } catch {
    return;
  }
  if (settled.every((track) => LEFT_THE_WORK_DIR.has(track.state)) && leftovers === 0) {
    try {
      rmSync(work, { recursive: true, force: true });
    } catch {
      // Another job got there first, which is the state we were asking for.
    }
  }
}

export async function placeStep(ctx: StepContext): Promise<StepResult> {
  const mapped = await ctx.mappedTracks();
  const movable = mapped.filter(
    (track) => track.state === "tagged" || track.state === "placed" || track.state === "done",
  );
  if (movable.length === 0) {
    await cleanWorkDir(ctx);
    return { status: "skipped", message: "Nothing to place." };
  }

  // The layout is a template now (P07a, Settings › Library & files). Its default renders
  // byte-for-byte what `trackPath` always did — `paths/template.test.ts` is what keeps that
  // true, and it is what lets this line change without re-filing anybody's library.
  const options: TemplateOptions = {
    mode: ctx.settings.sanitizeMode as SanitizeMode,
    maxSegmentLength: ctx.settings.maxSegmentLength,
    discMode: ctx.settings.discMode as DiscMode,
  };
  const onExists = ctx.job.options.force === true ? "overwrite" : ctx.settings.onExists;

  let placed = 0;
  let sidecars = 0;
  /** Tracks that got no `.lrc`, so the message can say why one is missing. */
  const withoutLyrics: string[] = [];
  let albumId: string | null = null;
  let folder: string | null = null;
  let cover: string | null = null;
  let albumArtist: string | null = null;

  for (const track of movable) {
    if (aborted(ctx)) {
      return { status: "blocked", blockedAs: "paused", message: "Stopped during placement." };
    }
    const source = track.downloadPath;
    const document = await documentOf(ctx, track.id);
    if (document === null) continue;

    await ctx.say("track.started", `${track.sourceTitle}: filing into the library`, {
      trackId: track.id,
      data: { stage: "place", done: placed, total: movable.length },
    });

    const extension = (source ?? track.libraryPath ?? ".opus").split(".").pop() ?? "opus";
    const input = pathInputFor(document, track, extension);
    // Not `const`: `keep_both` files the track under another name, and `result.path` below is
    // the only witness of which one.
    let relative = renderPathTemplate(ctx.settings.pathTemplate, input, options);
    folder ??= renderAlbumFolder(ctx.settings.pathTemplate, input, options);
    cover ??= coverUrl(document);
    albumArtist ??= input.albumArtist;
    albumId ??= await upsertAlbum(ctx, input, options, document);

    let size = track.downloadedBytes ?? 0;
    if (source !== null && existsSync(hostPath(ctx.paths, source))) {
      /*
       * The destination is written **before** the move, and that ordering is the whole of
       * "resume" for this step.
       *
       * `/place` is a rename: the instant it returns, the file has left the work directory,
       * and until the rows below are written nothing in the database knows where it went. A
       * worker killed in that window left the track with a `downloadPath` pointing at a file
       * that is gone, no `library_tracks` row yet, and a state still short of `placed` — so
       * the restarted `download` found nothing on disk anywhere and fetched the track a
       * second time. That is the one thing this app is built never to do, and it is what
       * `e2e-fixture`'s "no track was downloaded twice" caught once the steps were pipelined
       * (decision 147) and the kill started landing inside a `place` instead of between two
       * downloads.
       *
       * Recording the intent first makes the window harmless in both directions: the file is
       * either still in the work directory — `download` reuses it — or already at
       * `libraryPath`, where `download` now looks for it. Withdrawn again if the move failed
       * *and left nothing behind* (see the `catch`), so `verify` is never handed a path
       * nothing was ever written to.
       */
      await updateTrack(ctx, track.id, { libraryPath: relative });
      let result: Awaited<ReturnType<typeof ctx.toolbox.place>>;
      try {
        result = await ctx.toolbox.place({
          src: containerPath(ctx.paths, source),
          dest: containerPath(ctx.paths, relative),
          onExists,
        });
      } catch (error) {
        /*
         * A failed call is **not** proof that nothing moved. The rename belongs to the
         * container, which finishes it whatever happens to the connection — that is the exact
         * behaviour the investigation pinned the duplicate on — so a timeout, an aborted
         * fetch or a dropped socket can all come back here with the file already at its
         * destination. Clearing the row unconditionally would hand the next `download` a
         * track with no file anywhere and re-open the window the line above closes.
         *
         * So ask the filesystem, which is the only honest witness: the intent is withdrawn
         * only when the destination really is empty.
         */
        if (fileOnDisk(ctx.paths, relative) === null) {
          await updateTrack(ctx, track.id, { libraryPath: track.libraryPath });
        }
        throw error;
      }
      size = result.size;
      /*
       * Where the file *actually* landed.
       *
       * Under `onExists: keep_both` the toolbox renames `04 Within.opus` to
       * `04 Within (2).opus` and says so in `result.path`; asking for a name is not being
       * given it. Everything below this line — `import_tracks.library_path`,
       * `library_tracks.path`, the `.lrc` next to the audio — used to record the name we
       * asked for, so the rows pointed at a file that is not there: `scan` reports the track
       * missing and the real file as an orphan, the sidecar lands beside nothing, and
       * `download`'s skip looks for the track at a path that was never written.
       */
      relative = toRelative(ctx.paths, result.path) ?? relative;
      await ctx.say(
        "track.done",
        `${track.sourceTitle}: ${result.moved ? "placed" : "left in place"} at ${relative}`,
        { trackId: track.id, data: { path: relative, moved: result.moved } },
      );
      placed += 1;
    } else {
      /*
       * No source to move. Either the file is already at its destination — an earlier run of
       * this step that was killed between the rename and the rows below, which is the case
       * `libraryPath`-before-the-move exists to survive — or there is nothing here at all and
       * the track is not this step's business.
       *
       * The size is read from the file rather than from `downloadedBytes`, which was measured
       * before `tag` and ReplayGain wrote to it and would put a stale number in
       * `library_tracks`.
       */
      const already = fileOnDisk(ctx.paths, relative);
      if (already === null) continue;
      size = statSync(hostPath(ctx.paths, already)).size;
    }

    await updateTrack(ctx, track.id, {
      libraryPath: relative,
      state: "placed",
      downloadPath: null,
    });
    await upsertLibraryTrack(ctx, albumId, track, document, relative, size);

    // The `.lrc` sidecar rides with the file, not with the work directory.
    if (ctx.settings.writeLyricsSidecar) {
      const lyrics = lyricsText(document);
      // A track LRCLIB has no synced lyrics for is ordinary, not a failure — but
      // "13 file(s) placed, 12 sidecar(s) written" with nothing said about the thirteenth
      // reads like one. Remember which tracks, and say so at the end.
      if (lyrics === null) withoutLyrics.push(track.trackTitle ?? track.sourceTitle);
      if (lyrics !== null) {
        // Next to the audio file, whatever the template put it — not next to where the
        // default layout would have put it.
        const target = hostPath(ctx.paths, relative.replace(/\.[^./]+$/, ".lrc"));
        mkdirSync(dirname(target), { recursive: true });
        writeFileSync(target, lyrics.endsWith("\n") ? lyrics : `${lyrics}\n`, "utf8");
        sidecars += 1;
      }
    }
  }

  if (folder !== null && (await writeCover(ctx, folder, cover))) sidecars += 1;

  // `artist.jpg`, once per album placed (§3) — the artist folder is the album folder's first
  // segment, whatever the path template put there. Never fails the step: a download error here
  // is journaled and the import still finishes, exactly like a missing `.lrc`.
  if (folder !== null && albumArtist !== null) {
    const artistFolder = folder.split("/")[0] ?? "";
    const image = await writeArtistImageSidecar({
      db: ctx.db,
      toolbox: ctx.toolbox,
      paths: ctx.paths,
      artistName: albumArtist,
      artistFolder,
      size: ctx.settings.artworkSize,
      enabled: ctx.settings.writeArtistImage,
    });
    if (image.outcome === "written") sidecars += 1;
    if (image.outcome === "error") {
      await ctx.say("track.warn", `Could not write artist.jpg for ${albumArtist}: ${image.error}`, {
        level: "warn",
        data: { artist: albumArtist, folder: artistFolder },
      });
    }
  }

  if (albumId !== null) {
    await ctx.db
      .update(libraryAlbums)
      .set({
        coverPath: folder === null ? null : `${folder}/cover.jpg`,
        updatedAt: new Date(),
      })
      .where(eq(libraryAlbums.id, albumId));
    /*
     * The counters are not this step's to invent.
     *
     * It used to write `trackCount: Math.max(present.length, album.length)` — the import's own
     * mapped-track count as a stand-in for the release's — while the migration wrote
     * `tracks.length` and the scan wrote the row count. Three writers, three definitions, one
     * pair of columns. `recountAlbum` is the single rule (`services/album-counters.ts`): the
     * release that `match` has already pulled into `source_cache` is the total, and a playlist
     * that was eleven tracks of a thirteen-track record now says `11/13` instead of `11/11`.
     */
    await recountAlbum(albumId, ctx.db);
  }

  await cleanWorkDir(ctx);

  return {
    status: "done",
    message: placeMessage({
      placed,
      sidecars,
      withoutLyrics,
      writeLyricsSidecar: ctx.settings.writeLyricsSidecar,
    }),
    data: { placed, sidecars, folder, withoutLyrics },
  };
}
