/**
 * Step 6 — `tag` (app + toolbox).
 *
 * The three layers of `docs/03-metadonnees.md` §1 meet here: the raw cache produces the
 * **document** (`packages/domain`'s resolvers), the document is **projected** into Vorbis
 * key/value pairs, and the toolbox writes them with mutagen. The app owns every tag *name*;
 * the toolbox owns the *encoding*. Nothing about MusicBrainz crosses the bridge.
 *
 * `/replaygain` runs once per album, after every track is tagged — rsgain measures the album
 * as a whole, so its album figures are only correct when all the files are on disk. The
 * measured loudness is then merged back into the stored documents, because the database, not
 * the file, is the source of truth (decision 006).
 *
 * P04 replaced the recorded-fixture shortcut of P03 with `documents.service`, and the step
 * itself barely changed: it asks for a document and projects it. Two things are worth
 * knowing about the seam:
 *
 *  - **fixtures mode builds offline.** `MM_FIXTURES=1` means "the raw cache already holds
 *    every answer" (`bun run cache:seed-fixtures`), so the build is run with `offline: true`
 *    and cannot reach the network even by accident. A source the fixture set does not cover
 *    is simply skipped, and the field it owns stays missing.
 *  - **the loudness goes into the raw cache**, under `("rsgain", "track/<import track id>")`,
 *    before the documents are rebuilt. rsgain measures *our* file, so its numbers are a
 *    source response like any other — and putting them there is what lets an offline rebuild
 *    reproduce the very same document months later (§8).
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { MMError } from "@mm/contracts";
import {
  applyAlbumScopeTo,
  changedChoices,
  formatProjection,
  projectDocument,
  projectPictures,
  TAG_SCHEMA_VERSION,
  type AlbumScopeResolution,
  type ProjectedTag,
  type TrackDocument,
} from "@mm/domain";
import { eq } from "drizzle-orm";
import { metadataDocuments, type ImportTrack } from "#/server/db/schema/index.ts";
import { containerPath, hostPath } from "#/server/paths.ts";
import { put as cachePut } from "#/server/services/cache.ts";
import { download as downloadArtwork } from "#/server/integrations/coverartarchive.ts";
import { sourcesConfig, type SourceContext } from "#/server/integrations/config.ts";
import { describeChoices, resolveOver } from "#/server/services/album-scope.ts";
import {
  build as buildDocument,
  rsgainKey,
  RSGAIN_SOURCE,
  storeDocument,
} from "#/server/services/documents.ts";
import type { MeasuredLoudness } from "#/server/services/sources/fixtures.ts";
import type { Picture, Tag } from "#/server/toolbox/client.ts";
import type { StepResult } from "../machine.ts";
import { aborted, updateTrack, type StepContext } from "../context.ts";

/** States in which a track has a file that can be written to. */
const TAGGABLE = new Set(["downloaded", "fingerprinted", "tagged"]);
/** States in which the file is already in the library and only needs measuring. */
const IN_LIBRARY = new Set(["placed", "done", "skipped"]);

/**
 * R128 gain in Q7.8 fixed point, from a ReplayGain figure measured against `reference`.
 *
 * Mirrors `r128_gain()` in `services/toolbox/src/toolbox/replaygain.py`: R128 is defined
 * against −23 LUFS while ReplayGain is measured against the reference we asked for, so the
 * two differ by exactly that offset. Kept in step with the Python by a unit test on both
 * sides rather than by hope.
 */
export function r128Gain(gainDb: number, referenceLoudness: number): number {
  return Math.round((gainDb + (-23 - referenceLoudness)) * 256);
}

/** Stable fingerprint of a projection, so a re-tag can skip a file that would not change. */
export function projectionHash(tags: readonly ProjectedTag[]): string {
  return createHash("sha256").update(formatProjection(tags)).digest("hex").slice(0, 32);
}

/** The file a track currently lives in, library-relative, or `null` when it has none. */
function currentFile(track: ImportTrack): string | null {
  if (IN_LIBRARY.has(track.state) && track.libraryPath !== null) return track.libraryPath;
  return track.downloadPath;
}

/**
 * One track's document, from the real sources through the raw cache.
 *
 * Offline in fixtures mode, online otherwise. `documents.service` persists it, so this step
 * no longer writes `metadata_documents` itself — which also means a document built here and
 * one rebuilt by `mm doc rebuild` cannot drift apart.
 */
async function documentFor(ctx: StepContext, track: ImportTrack): Promise<TrackDocument> {
  const built = await buildDocument(track.id, {
    db: ctx.db,
    settings: ctx.settings,
    offline: ctx.fixtures,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });
  return built.document;
}

/**
 * Fetch and cache the album art once, whatever the number of tracks that embed it.
 *
 * Through the same client `documents.service` uses, so the prepared JPEG lands in the raw
 * cache under one key and an offline re-tag finds it there.
 */
async function artwork(
  ctx: StepContext,
  url: string,
): Promise<{ data_base64: string; mime: string }> {
  const sourceCtx: SourceContext = {
    db: ctx.db,
    config: sourcesConfig(ctx.settings),
    offline: false,
    refresh: false,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  };
  return await downloadArtwork(sourceCtx, ctx.toolbox, url, ctx.settings.artworkSize);
}

async function pictureList(ctx: StepContext, document: TrackDocument): Promise<Picture[]> {
  if (!ctx.settings.embedArtwork) return [];
  const out: Picture[] = [];
  for (const picture of projectPictures(document, "vorbis")) {
    try {
      const prepared = await artwork(ctx, picture.url);
      out.push({
        type: picture.kind === "back" ? 4 : 3,
        mime: prepared.mime,
        data_base64: prepared.data_base64,
        description: picture.comment ?? "",
      });
    } catch (error) {
      // A missing cover must not cost the tags. Say so and carry on.
      await ctx.say("track.progress", `Cover unavailable: ${MMError.from(error).message}`, {
        level: "warn",
        data: { url: picture.url },
      });
    }
  }
  return out;
}

/** The synchronised lyrics of a document, for the `.lrc` sidecar. */
export function lyricsOf(document: TrackDocument): string | null {
  const held = document.fields["lyrics"]?.value;
  if (typeof held !== "object" || held === null || Array.isArray(held)) return null;
  const value = held as { synced?: string | null; plain?: string | null };
  return value.synced ?? value.plain ?? null;
}

/** Only the projection hash is written here; the document itself is `documents.service`'s. */
async function storeProjectionHash(
  ctx: StepContext,
  track: ImportTrack,
  hash: string,
): Promise<void> {
  await ctx.db
    .update(metadataDocuments)
    .set({ projectionHash: hash, updatedAt: new Date() })
    .where(eq(metadataDocuments.importTrackId, track.id));
}

/**
 * Give the album one value per `albumScope` field, and store it.
 *
 * The documents are rewritten in the database too, not only on the way to the toolbox: the
 * database is the source of truth (§1), so a score, an export or a re-tag reading them later
 * must see the album's value and not the recording's. That is also what makes the album's
 * completeness equal to its tracks' — the divergence penalty has nothing left to punish.
 */
async function unifyScope(
  ctx: StepContext,
  tracks: readonly ImportTrack[],
  documents: Map<string, TrackDocument>,
): Promise<AlbumScopeResolution> {
  const ordered = tracks
    .map((track) => documents.get(track.id))
    .filter((document): document is TrackDocument => document !== undefined);
  if (ordered.length === 0) return { choices: [], divergentFields: [] };

  const resolution = await resolveOver(ordered, {
    db: ctx.db,
    settings: ctx.settings,
    releaseMbid: ctx.job.releaseMbid,
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  });

  const changes = changedChoices(resolution);
  if (changes.length === 0) return resolution;

  for (const track of tracks) {
    const held = documents.get(track.id);
    if (held === undefined) continue;
    const unified = applyAlbumScopeTo(held, resolution);
    if (unified === held) continue;
    documents.set(track.id, unified);
    await storeDocument(track.id, unified, ctx.db);
  }

  await ctx.say("step.progress", `Album-scope fields unified: ${describeChoices(changes)}.`, {
    data: { fields: changes.map((choice) => choice.field) },
  });
  return resolution;
}

export async function tagStep(ctx: StepContext): Promise<StepResult> {
  const mapped = await ctx.mappedTracks();
  const toWrite = mapped.filter(
    (track) => TAGGABLE.has(track.state) && track.downloadPath !== null,
  );

  if (toWrite.length === 0 && mapped.every((track) => track.state === "skipped")) {
    return { status: "skipped", message: "already present (nothing to tag)" };
  }

  const documents = new Map<string, TrackDocument>();
  let written = 0;

  /*
   * ---- 1 · every document first, then the album's own value for the album-scope fields ----
   *
   * The old loop built one document and wrote its file straight away, which is why the album
   * ended up with thirteen different `GENRE`s: the recording is a per-track entity, and no
   * track can know what the *album*'s genre is until the others have been read. Building the
   * whole album before writing anything costs nothing — every source goes through the raw
   * cache — and it is what `albumScope: true` has meant all along (fourth test report, §1).
   */
  const buildable = toWrite.filter((track) => {
    const relative = track.downloadPath;
    return relative !== null && existsSync(hostPath(ctx.paths, relative));
  });

  for (const track of buildable) {
    if (aborted(ctx)) {
      return { status: "blocked", blockedAs: "paused", message: "Stopped during tagging." };
    }
    // Which track is being worked on, before the work starts. Tagging an album is a minute of
    // silence otherwise — the owner's C7 — because the only line this loop wrote was the one
    // that said a track was *finished*.
    await ctx.say("track.started", `${track.sourceTitle}: reading sources and writing tags`, {
      trackId: track.id,
      data: { stage: "tag", done: documents.size, total: buildable.length },
    });
    documents.set(track.id, await documentFor(ctx, track));
  }

  const scope = await unifyScope(ctx, buildable, documents);

  /* ---- 2 · project and write, from the unified documents ---- */
  for (const track of buildable) {
    if (aborted(ctx)) {
      return { status: "blocked", blockedAs: "paused", message: "Stopped during tagging." };
    }
    const relative = track.downloadPath;
    const document = documents.get(track.id);
    if (relative === null || document === undefined) continue;

    const tags: Tag[] = projectDocument(document, "vorbis").map((tag) => ({
      key: tag.key,
      value: tag.value,
    }));
    const pictures = await pictureList(ctx, document);
    const lrc = lyricsOf(document);

    const result = await ctx.toolbox.tag({
      path: containerPath(ctx.paths, relative),
      format: "auto",
      tags,
      pictures,
      lyrics_lrc: lrc,
      sidecar_lrc: false,
      // Rewriting the whole block is what makes this step idempotent: a second run leaves
      // exactly the same tags, not the union of two projections.
      clear: true,
    });

    await updateTrack(ctx, track.id, { state: "tagged" });
    await ctx.say("track.done", `${track.sourceTitle}: ${String(result.written)} tags written`, {
      trackId: track.id,
      data: { tags: result.written, pictures: result.pictures },
    });
    written += 1;
  }

  /* ---- album ReplayGain, once every track is on disk ---- */
  let loudness = new Map<string, MeasuredLoudness>();
  let replaygain: string | null = null;

  const measurable = mapped.filter((track) => {
    const file = currentFile(track);
    return file !== null && existsSync(hostPath(ctx.paths, file));
  });

  if (ctx.settings.replayGain && ctx.job.options.replaygain !== false && measurable.length > 0) {
    const complete = measurable.length === mapped.length;
    if (!complete) {
      replaygain = `skipped: ${String(mapped.length - measurable.length)} track(s) missing`;
      await ctx.say("step.skipped", `ReplayGain skipped: the album is not complete yet.`, {
        level: "warn",
      });
    } else {
      const files = measurable.map((track) => containerPath(ctx.paths, currentFile(track) ?? ""));
      const scan = await ctx.toolbox.replaygain({
        files,
        album: true,
        referenceLoudness: ctx.settings.replayGainReferenceLoudness,
        write: true,
      });
      const reference = scan.reference_loudness;
      loudness = new Map(
        measurable.map((track, index) => {
          const file = scan.files[index];
          const measured: MeasuredLoudness = {
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
          return [track.id, measured];
        }),
      );
      replaygain = `${String(scan.files.length)} file(s), album gain ${scan.album?.gain.toFixed(2) ?? "n/a"} dB`;
      await ctx.say("step.done", `ReplayGain: ${replaygain}`, {
        data: { r128: scan.r128, reference },
      });
    }
  }

  /* ---- the loudness enters the raw cache, then the documents are rebuilt from it ---- */
  for (const [trackId, measured] of loudness) {
    await cachePut(RSGAIN_SOURCE, rsgainKey(trackId), measured, { db: ctx.db });
  }

  for (const track of mapped) {
    const built = documents.get(track.id);
    const measured = loudness.get(track.id);
    if (built === undefined && measured === undefined) continue;
    // A track that was measured is rebuilt so its document carries the loudness; one that was
    // only tagged already has the document `documents.service` persisted a moment ago. Both
    // paths go through the same builder, offline, so neither can invent a different answer.
    //
    // The rebuild goes back to the raw cache, so it also brings back the *recording*'s genre
    // and this video's own ℗ line: the album-scope pass has to be replayed on top, and the
    // result stored, or the loudness would silently undo the unification a few lines above.
    let document = measured === undefined ? built : await documentFor(ctx, track);
    if (document === undefined) continue;
    if (measured !== undefined) {
      const unified = applyAlbumScopeTo(document, scope);
      if (unified !== document) {
        document = unified;
        await storeDocument(track.id, unified, ctx.db);
      }
    }
    await storeProjectionHash(ctx, track, projectionHash(projectDocument(document, "vorbis")));
  }

  return {
    status: "done",
    message: `${String(written)} track(s) tagged${replaygain === null ? "" : `; replaygain ${replaygain}`}`,
    data: { tagged: written, replaygain, tagSchemaVersion: TAG_SCHEMA_VERSION },
  };
}
