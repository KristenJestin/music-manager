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
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
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
import { containerPath, hostPath, workFolder } from "#/server/paths.ts";
import { getOrFetch } from "#/server/services/cache.ts";
import type { StepResult } from "../machine.ts";
import { aborted, updateTrack, type StepContext } from "../context.ts";

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

  const id = newId("libraryAlbum");
  await ctx.db.insert(libraryAlbums).values({
    id,
    releaseMbid: ctx.job.releaseMbid,
    releaseGroupMbid,
    albumArtist: input.albumArtist,
    title: input.album,
    year: year === null || Number.isNaN(year) ? null : year,
    folder,
  });
  return id;
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
      .select({ id: libraryTracks.id })
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
    if (byPosition !== undefined) return byPosition;
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
    updatedAt: new Date(),
  };

  let libraryTrackId: string;
  if (row === null) {
    libraryTrackId = newId("libraryTrack");
    await ctx.db.insert(libraryTracks).values({ id: libraryTrackId, path: relative, ...values });
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
  const settled = await ctx.mappedTracks();
  const leftovers = readdirSync(work, { withFileTypes: true }).filter(
    (entry) => entry.isFile() && !entry.name.startsWith("."),
  );
  if (settled.every((track) => LEFT_THE_WORK_DIR.has(track.state)) && leftovers.length === 0) {
    rmSync(work, { recursive: true, force: true });
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
    const relative = renderPathTemplate(ctx.settings.pathTemplate, input, options);
    folder ??= renderAlbumFolder(ctx.settings.pathTemplate, input, options);
    cover ??= coverUrl(document);
    albumId ??= await upsertAlbum(ctx, input, options, document);

    let size = track.downloadedBytes ?? 0;
    if (source !== null && existsSync(hostPath(ctx.paths, source))) {
      const result = await ctx.toolbox.place({
        src: containerPath(ctx.paths, source),
        dest: containerPath(ctx.paths, relative),
        onExists,
      });
      size = result.size;
      await ctx.say(
        "track.done",
        `${track.sourceTitle}: ${result.moved ? "placed" : "left in place"} at ${relative}`,
        { trackId: track.id, data: { path: relative, moved: result.moved } },
      );
      placed += 1;
    } else if (!existsSync(hostPath(ctx.paths, relative))) {
      continue;
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

  if (albumId !== null) {
    const present = await ctx.db
      .select({ id: libraryTracks.id })
      .from(libraryTracks)
      .where(eq(libraryTracks.albumId, albumId));
    await ctx.db
      .update(libraryAlbums)
      .set({
        presentCount: present.length,
        trackCount: Math.max(present.length, mapped.length),
        coverPath: folder === null ? null : `${folder}/cover.jpg`,
        updatedAt: new Date(),
      })
      .where(eq(libraryAlbums.id, albumId));
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
