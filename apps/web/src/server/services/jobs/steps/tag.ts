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
 * In P03 the source data is the recorded Discovery fixture; P04 replaces that with the real
 * sources and nothing else in this step changes.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { MMError } from "@mm/contracts";
import {
  formatProjection,
  projectDocument,
  projectPictures,
  TAG_SCHEMA_VERSION,
  trackCompleteness,
  type ProjectedTag,
  type TrackDocument,
  type YtdlpEntry,
} from "@mm/domain";
import { metadataDocuments, type ImportTrack } from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { containerPath, hostPath } from "#/server/paths.ts";
import { getOrFetch } from "#/server/services/cache.ts";
import {
  buildDocument,
  isDiscoveryFixture,
  type MeasuredLoudness,
} from "#/server/services/sources/fixtures.ts";
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

async function documentFor(
  ctx: StepContext,
  track: ImportTrack,
  loudness: MeasuredLoudness | undefined,
): Promise<TrackDocument> {
  const now = new Date();
  return buildDocument({
    trackPosition: track.trackPosition ?? 1,
    importId: ctx.job.id,
    sourceUrl: track.url,
    entry: track.raw as YtdlpEntry,
    fetchedAt: now.toISOString(),
    importedOn: now.toISOString().slice(0, 10),
    ...(loudness === undefined ? {} : { loudness }),
    opus: (currentFile(track) ?? "").toLowerCase().endsWith(".opus"),
  });
}

/** Fetch and cache the album art once, whatever the number of tracks that embed it. */
async function artwork(
  ctx: StepContext,
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

async function storeDocument(
  ctx: StepContext,
  track: ImportTrack,
  document: TrackDocument,
  hash: string,
): Promise<void> {
  const score = trackCompleteness(document).score;
  await ctx.db
    .insert(metadataDocuments)
    .values({
      id: newId("metadataDocument"),
      importTrackId: track.id,
      recordingMbid: track.recordingMbid,
      document: document as unknown as Record<string, unknown>,
      tagSchemaVersion: TAG_SCHEMA_VERSION,
      projectionHash: hash,
      completeness: score,
    })
    .onConflictDoUpdate({
      target: metadataDocuments.importTrackId,
      set: {
        document: document as unknown as Record<string, unknown>,
        recordingMbid: track.recordingMbid,
        tagSchemaVersion: TAG_SCHEMA_VERSION,
        projectionHash: hash,
        completeness: score,
        updatedAt: new Date(),
      },
    });
}

export async function tagStep(ctx: StepContext): Promise<StepResult> {
  const mapped = await ctx.mappedTracks();
  const toWrite = mapped.filter(
    (track) => TAGGABLE.has(track.state) && track.downloadPath !== null,
  );

  if (!isDiscoveryFixture(ctx.job.url)) {
    return {
      status: "failed",
      message: "No metadata sources yet: P03 can only build a document for the recorded fixture.",
      error: {
        code: "STEP_FAILED",
        message: "The metadata sources (MusicBrainz, CAA, LRCLIB, Deezer) arrive in P04.",
        hint: "Import `fixture://discovery` to exercise the pipeline offline.",
        action: "Use a recorded fixture",
      },
    };
  }

  if (toWrite.length === 0 && mapped.every((track) => track.state === "skipped")) {
    return { status: "skipped", message: "already present (nothing to tag)" };
  }

  const documents = new Map<string, TrackDocument>();
  let written = 0;

  for (const track of toWrite) {
    if (aborted(ctx)) {
      return { status: "blocked", blockedAs: "paused", message: "Stopped during tagging." };
    }
    const relative = track.downloadPath;
    if (relative === null || !existsSync(hostPath(ctx.paths, relative))) continue;

    const document = await documentFor(ctx, track, undefined);
    documents.set(track.id, document);

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

  /* ---- store the documents, loudness included ---- */
  for (const track of mapped) {
    const base = documents.get(track.id);
    const measured = loudness.get(track.id);
    if (base === undefined && measured === undefined) continue;
    const document = measured === undefined ? base : await documentFor(ctx, track, measured);
    if (document === undefined) continue;
    const tags = projectDocument(document, "vorbis");
    await storeDocument(ctx, track, document, projectionHash(tags));
  }

  return {
    status: "done",
    message: `${String(written)} track(s) tagged${replaygain === null ? "" : `; replaygain ${replaygain}`}`,
    data: { tagged: written, replaygain, tagSchemaVersion: TAG_SCHEMA_VERSION },
  };
}
