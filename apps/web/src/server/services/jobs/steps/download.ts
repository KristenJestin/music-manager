/**
 * Step 4 — `download` (toolbox).
 *
 * One file at a time, in tracklist order, with a 5–15 s jitter between them and an
 * exponential backoff on failure (`docs/04-pipeline-et-matching.md` § Étapes). The single
 * download slot is enforced twice over: this step runs on pg-boss's global `download` queue
 * with `teamSize: 1`, and the toolbox itself answers `409 LOCKED` to a second caller.
 *
 * Three rules make it resumable, which is what the acceptance criteria actually test:
 *
 *  - a track whose file is already on disk is not downloaded again — the step re-reads the
 *    filesystem rather than trusting its own row;
 *  - a recording already in the library is skipped entirely unless `--force`
 *    (`docs/04` § Règles: "sans force, un recording déjà présent est ignoré");
 *  - each track's outcome is persisted before the next one starts, so killing the worker
 *    costs at most one partial file, which yt-dlp's `--continue` picks up anyway.
 */
import { existsSync, mkdirSync, statSync } from "node:fs";
import { eq } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { libraryTracks, type ImportTrack } from "#/server/db/schema/index.ts";
import { containerPath, hostPath, toRelative, workFolder } from "#/server/paths.ts";
import { cookieJar } from "#/server/services/cookies.ts";
import { backoffMs, jitterMs, type StepResult } from "../machine.ts";
import { aborted, sleep, setTrackState, updateTrack, type StepContext } from "../context.ts";

/** How often a `progress` event is written to the journal. The toolbox emits four a second. */
const PROGRESS_EVERY_MS = 2_000;

/** True when this recording is already sitting in the library. */
async function alreadyInLibrary(ctx: StepContext, recordingMbid: string | null): Promise<boolean> {
  if (recordingMbid === null || recordingMbid === "") return false;
  const [row] = await ctx.db
    .select({ path: libraryTracks.path })
    .from(libraryTracks)
    .where(eq(libraryTracks.recordingMbid, recordingMbid))
    .limit(1);
  if (row === undefined) return false;
  // A row whose file has been deleted behind our back is not "already present".
  return existsSync(hostPath(ctx.paths, row.path));
}

/** The file this track would download to, library-relative. */
function targetRelative(ctx: StepContext, track: ImportTrack): string {
  return `${workFolder(ctx.paths, ctx.job.id)}/${track.id}.opus`;
}

/**
 * Containers `tag` can actually write to — the same list as the toolbox's
 * `TAGGABLE_SUFFIXES`. A `.webm` left behind by an older, pre-remux download must **not**
 * count as "already downloaded": reusing it would walk straight back into
 * `TAG_WRITE_FAILED — Unsupported container '.webm'` on every retry.
 */
const TAGGABLE_SUFFIXES = new Set([
  ".opus",
  ".ogg",
  ".oga",
  ".flac",
  ".mp3",
  ".mp2",
  ".m4a",
  ".mp4",
  ".m4b",
  ".aac",
]);

function taggable(relative: string): boolean {
  const dot = relative.lastIndexOf(".");
  return dot === -1 ? false : TAGGABLE_SUFFIXES.has(relative.slice(dot).toLowerCase());
}

/** True when a previous run already produced a non-empty, taggable file for this track. */
function fileReady(ctx: StepContext, track: ImportTrack): string | null {
  const candidates = [
    ...(track.downloadPath === null ? [] : [track.downloadPath]),
    targetRelative(ctx, track),
  ];
  for (const relative of candidates) {
    if (!taggable(relative)) continue;
    const absolute = hostPath(ctx.paths, relative);
    if (existsSync(absolute) && statSync(absolute).size > 0) return relative;
  }
  return null;
}

async function downloadOne(ctx: StepContext, track: ImportTrack): Promise<number> {
  const destDir = containerPath(ctx.paths, workFolder(ctx.paths, ctx.job.id));
  let lastProgress = 0;
  let size = 0;

  for await (const event of ctx.toolbox.download({
    url: track.url,
    destDir,
    id: track.id,
    format: ctx.settings.downloadFormat,
    // The configured session, whether it is a path the container can read or a jar pasted
    // into Settings. Without this a bot check reads like YouTube's fault rather than ours.
    cookies: cookieJar(ctx.settings),
    ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
  })) {
    switch (event.event) {
      case "progress": {
        const now = Date.now();
        if (now - lastProgress < PROGRESS_EVERY_MS) break;
        lastProgress = now;
        await ctx.say("track.progress", `${track.sourceTitle}: downloading`, {
          trackId: track.id,
          data: {
            downloaded: event.downloaded,
            total: event.total,
            speed: event.speed ?? null,
            eta: event.eta ?? null,
          },
        });
        break;
      }
      case "postprocess":
        await ctx.say("track.progress", `${track.sourceTitle}: ${event.step}`, {
          trackId: track.id,
          data: { postprocess: event.step },
        });
        break;
      case "done": {
        size = event.size;
        const relative = toRelative(ctx.paths, event.path) ?? targetRelative(ctx, track);
        await updateTrack(ctx, track.id, {
          downloadPath: relative,
          downloadedBytes: event.size,
          state: "downloaded",
          error: null,
        });
        break;
      }
      case "error":
        throw MMError.fromBody(event, "The download failed.");
    }
  }
  return size;
}

export async function downloadStep(ctx: StepContext): Promise<StepResult> {
  const tracks = await ctx.mappedTracks();
  if (tracks.length === 0) {
    return { status: "skipped", message: "No mapped track to download." };
  }

  // The work directory is inside the library bind mount, so `place` is a rename on the same
  // filesystem — genuinely atomic — and the leading dot keeps it out of Navidrome's scan.
  mkdirSync(hostPath(ctx.paths, workFolder(ctx.paths, ctx.job.id)), { recursive: true });

  const force = ctx.job.options.force === true;
  let downloaded = 0;
  let reused = 0;
  let skipped = 0;
  const failures: { track: string; error: MMError }[] = [];

  for (const track of tracks) {
    if (aborted(ctx)) {
      return {
        status: "blocked",
        blockedAs: "paused",
        message: `Stopped after ${String(downloaded)} download(s).`,
        data: { downloaded, reused, skipped },
      };
    }

    if (!force && (await alreadyInLibrary(ctx, track.recordingMbid))) {
      await setTrackState(ctx, track.id, "skipped", { note: "already present" });
      await ctx.say("track.skipped", `${track.sourceTitle}: already present`, {
        trackId: track.id,
        data: { reason: "already present", recordingMbid: track.recordingMbid },
      });
      skipped += 1;
      continue;
    }

    const ready = fileReady(ctx, track);
    if (ready !== null && !force) {
      await updateTrack(ctx, track.id, {
        downloadPath: ready,
        downloadedBytes: statSync(hostPath(ctx.paths, ready)).size,
        ...(track.state === "pending" ? { state: "downloaded" as const } : {}),
      });
      await ctx.say("track.skipped", `${track.sourceTitle}: already downloaded`, {
        trackId: track.id,
        data: { reason: "already downloaded", path: ready },
      });
      reused += 1;
      continue;
    }

    // The pause belongs *between* downloads: nothing has been fetched yet on the first one.
    if (downloaded > 0) {
      const pause = ctx.fixtures
        ? 0
        : jitterMs(ctx.settings.downloadJitterMinMs, ctx.settings.downloadJitterMaxMs);
      if (pause > 0) {
        await ctx.say(
          "track.progress",
          `Waiting ${String(Math.round(pause / 1000))}s before the next download.`,
          {
            trackId: track.id,
            data: { jitterMs: pause },
          },
        );
        await sleep(pause, ctx.signal);
        if (aborted(ctx)) {
          return {
            status: "blocked",
            blockedAs: "paused",
            message: `Stopped after ${String(downloaded)} download(s).`,
            data: { downloaded, reused, skipped },
          };
        }
      }
    }

    await ctx.say("track.started", `${track.sourceTitle}: downloading`, { trackId: track.id });

    let attempt = 0;
    let lastError: MMError | null = null;
    while (attempt < ctx.settings.downloadMaxAttempts) {
      attempt += 1;
      try {
        const size = await downloadOne(ctx, track);
        await ctx.say("track.done", `${track.sourceTitle}: downloaded`, {
          trackId: track.id,
          data: { bytes: size, attempt },
        });
        downloaded += 1;
        lastError = null;
        break;
      } catch (error) {
        lastError = MMError.from(error);
        await updateTrack(ctx, track.id, { attempts: attempt, error: lastError.toBody() });
        const willRetry = lastError.retryable && attempt < ctx.settings.downloadMaxAttempts;
        await ctx.say(
          willRetry ? "track.progress" : "track.failed",
          `${track.sourceTitle}: ${lastError.message}`,
          {
            trackId: track.id,
            level: willRetry ? "warn" : "error",
            data: { attempt, code: lastError.code, willRetry },
          },
        );
        if (!willRetry) break;
        const pause = backoffMs(
          attempt,
          ctx.settings.downloadBackoffBaseMs,
          ctx.settings.downloadBackoffMaxMs,
        );
        await sleep(ctx.fixtures ? Math.min(pause, 100) : pause, ctx.signal);
        if (aborted(ctx)) break;
      }
    }

    if (lastError !== null) {
      await setTrackState(ctx, track.id, "failed", { error: lastError.toBody() });
      failures.push({ track: track.sourceTitle, error: lastError });
    }
  }

  const summary = { downloaded, reused, skipped, failed: failures.length };

  if (failures.length > 0) {
    const first = failures[0]?.error ?? new MMError("UNKNOWN", "Download failed.");
    return {
      status: "failed",
      message: `${String(failures.length)} download(s) failed: ${first.message}`,
      data: summary,
      error: first.toBody(),
    };
  }

  if (downloaded === 0 && skipped > 0 && reused === 0) {
    return {
      status: "skipped",
      message: `already present (${String(skipped)} track(s))`,
      data: summary,
    };
  }

  return {
    status: "done",
    message: `${String(downloaded)} downloaded, ${String(reused)} reused, ${String(skipped)} already present`,
    data: summary,
  };
}
