/**
 * Step 1 — `resolve` (toolbox, yt-dlp).
 *
 * Turn the submitted URL into rows: one `import_tracks` per video, with its duration, its
 * YouTube Music tags and its description kept verbatim. Nothing is downloaded.
 *
 * Idempotent by construction: if the videos are already there, the step re-reads them and
 * says so. Re-running it after a `--force` refresh replaces the raw payloads without
 * disturbing anything a later step wrote (the mapping, the download path, the fingerprint),
 * because those columns are matched on the video id, not on the row.
 */
import { eq } from "drizzle-orm";
import { imports, importTracks, type ImportKind } from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import type { ExtractEntry, ExtractResult } from "#/server/toolbox/client.ts";
import type { StepResult } from "../machine.ts";
import type { StepContext } from "../context.ts";

/** A URL that points at a channel rather than at a video or a playlist. */
const CHANNEL = /youtube\.com\/(?:channel\/|c\/|user\/|@)/i;

/**
 * What the URL turned out to be.
 *
 * The distinction that matters downstream is `album` vs `playlist`: an album gets one release
 * and one folder, a playlist is a bag of singles. YouTube Music sets the `album` tag on every
 * entry of an album playlist, so a strong majority agreeing on one album name is the signal.
 */
export function classify(url: string, extract: ExtractResult): ImportKind {
  if (CHANNEL.test(url)) return "channel";
  if (extract.kind === "video" || extract.entries.length <= 1) return "single";

  const albums = extract.entries.map((entry) => (entry.album ?? "").trim()).filter((a) => a !== "");
  if (albums.length === 0) return "playlist";
  const counts = new Map<string, number>();
  for (const album of albums) counts.set(album, (counts.get(album) ?? 0) + 1);
  const best = Math.max(...counts.values());
  return best / extract.entries.length >= 0.7 ? "album" : "playlist";
}

function entryUrl(entry: ExtractEntry, sourceUrl: string): string {
  if (entry.webpage_url !== null && entry.webpage_url !== undefined) return entry.webpage_url;
  // Fixture entries have no webpage_url: address them the way the toolbox expects.
  if (sourceUrl.startsWith("fixture://")) {
    const [base] = sourceUrl.split("#");
    return `${base ?? sourceUrl}#${String(entry.index)}`;
  }
  return `https://youtu.be/${entry.id}`;
}

export async function resolveStep(ctx: StepContext): Promise<StepResult> {
  const existing = await ctx.tracks();
  if (existing.length > 0 && ctx.job.options.force !== true) {
    return {
      status: "done",
      message: `${String(existing.length)} video(s) already resolved`,
      data: { videos: existing.length, reused: true },
    };
  }

  const extract = await ctx.toolbox.extract(ctx.job.url);
  if (extract.entries.length === 0) {
    return {
      status: "failed",
      message: "The URL resolved to no videos.",
      error: {
        code: "INVALID_INPUT",
        message: "The URL resolved to no videos.",
        hint: "Check the link, or try it in a browser — it may be private or region-locked.",
        action: "Find alternative",
      },
    };
  }

  const kind = classify(ctx.job.url, extract);
  const known = new Map(existing.map((row) => [row.videoId, row]));

  for (const entry of extract.entries) {
    const raw = entry as unknown as Record<string, unknown>;
    const found = known.get(entry.id);
    if (found === undefined) {
      await ctx.db.insert(importTracks).values({
        id: newId("importTrack"),
        importId: ctx.job.id,
        position: entry.index,
        videoId: entry.id,
        url: entryUrl(entry, ctx.job.url),
        sourceTitle: entry.title,
        sourceDuration: entry.duration ?? null,
        uploader: entry.uploader ?? null,
        raw,
      });
    } else {
      await ctx.db
        .update(importTracks)
        .set({
          position: entry.index,
          sourceTitle: entry.title,
          sourceDuration: entry.duration ?? null,
          uploader: entry.uploader ?? null,
          raw,
          updatedAt: new Date(),
        })
        .where(eq(importTracks.id, found.id));
    }
  }

  await ctx.db
    .update(imports)
    .set({
      kind,
      title: extract.title ?? extract.entries[0]?.title ?? null,
      artist: extract.uploader ?? extract.entries[0]?.uploader ?? null,
      updatedAt: new Date(),
    })
    .where(eq(imports.id, ctx.job.id));

  return {
    status: "done",
    message: `${String(extract.entries.length)} video(s), kind ${kind}`,
    data: { videos: extract.entries.length, kind, title: extract.title ?? null },
  };
}
