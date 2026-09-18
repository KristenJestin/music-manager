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
import { containerPath, hostPath, taggable, toRelative, workFolder } from "#/server/paths.ts";
import { cookieJar } from "#/server/services/cookies.ts";
import { adoptionOf } from "#/server/services/adopt.record.ts";
import { adoptTrackFile } from "#/server/services/adopt.ts";
import { folderFileOf } from "#/server/services/folder.record.ts";
import { backoffMs, jitterMs, type StepResult } from "../machine.ts";
import {
  aborted,
  fileOnDisk,
  sleep,
  setTrackState,
  updateTrack,
  type StepContext,
} from "../context.ts";

/** How often a `progress` event is written to the journal. The toolbox emits four a second. */
const PROGRESS_EVERY_MS = 2_000;

/** How long to wait before asking the toolbox for the single download slot again. */
const SLOT_POLL_MS = 3_000;

/**
 * How long a track may wait for the slot before this is treated as a real failure.
 *
 * Long enough to sit behind a 28-track album, short enough that a slot leaked by a crashed
 * caller does not hold a job open until the six-hour queue expiry.
 */
const SLOT_MAX_WAIT_MS = 60 * 60_000;

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
 * True when a previous run already produced a non-empty, taggable file for this track — or
 * when somebody adopted one into the work directory by hand (`services/adopt.ts`).
 *
 * `taggable` is `paths.ts`'s, shared with `adopt`: the containers this step is willing to
 * reuse and the containers that route is willing to accept have to be one list.
 */
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

  // `url` is nullable since the `sourceless` state, and a null one must never reach the
  // toolbox. `downloadStep` already skips those rows; this is the compiler's proof of it,
  // and it would rather say what went wrong than send `"null"` to yt-dlp.
  if (track.url === null) {
    throw new MMError("INVALID_INPUT", `${track.sourceTitle} has no source to download.`, {
      hint: "This track has no video. Adopt a file or a replacement address for it instead.",
      status: 409,
    });
  }

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
        // `percent` is computed here rather than in the Console: the two numbers it comes
        // from are on this line, and a reader of `job_events` should not have to divide.
        const percent =
          event.total !== null && event.total > 0
            ? Math.min(100, Math.round((event.downloaded / event.total) * 100))
            : null;
        await ctx.say(
          "track.progress",
          `${track.sourceTitle}: downloading${percent === null ? "" : ` ${String(percent)}%`}`,
          {
            trackId: track.id,
            data: {
              stage: "download",
              percent,
              downloaded: event.downloaded,
              total: event.total,
              speed: event.speed ?? null,
              eta: event.eta ?? null,
            },
          },
        );
        break;
      }
      case "postprocess":
        // yt-dlp's own sub-steps — `ExtractAudio`, `MoveFiles`… The owner asked to see them
        // (C2): between the end of the bytes and the file appearing there is a minute of
        // ffmpeg, and without this line the page looks stuck at 100%.
        await ctx.say("track.progress", `${track.sourceTitle}: ${event.step}`, {
          trackId: track.id,
          data: { stage: event.step, postprocess: event.step },
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

/**
 * `downloadOne`, except that a `409 LOCKED` is a **queue, not a failure**.
 *
 * The toolbox serves one download at a time on purpose, and something else holding the slot
 * is a reason to wait rather than to fail a track — then the step, then the album. That is
 * exactly what the owner saw (C3/C4): a `LOCKED` counted as an attempt, was logged at `warn`
 * and then at `error`, and after three of them the import was `Failed` with
 * `LOCKED: A download is already running.` The wait is announced once, at `info`, so the
 * journal says *waiting for the download slot* instead of stacking red lines for a queue
 * behaving normally.
 *
 * With `rewindTo` in place nothing of ours takes a second slot any more; this is the belt to
 * that pair of braces, for the operator's own `curl` and for a worker that outlived its
 * replacement.
 */
async function downloadOneWhenFree(ctx: StepContext, track: ImportTrack): Promise<number> {
  const deadline = Date.now() + SLOT_MAX_WAIT_MS;
  let announced = false;
  for (;;) {
    try {
      return await downloadOne(ctx, track);
    } catch (error) {
      const failure = MMError.from(error);
      if (failure.code !== "LOCKED" || aborted(ctx) || Date.now() >= deadline) throw failure;
      if (!announced) {
        announced = true;
        await ctx.say("track.waiting", `${track.sourceTitle}: waiting for the download slot`, {
          trackId: track.id,
          data: { stage: "waiting", reason: "LOCKED" },
        });
      }
      await sleep(ctx.fixtures ? Math.min(SLOT_POLL_MS, 200) : SLOT_POLL_MS, ctx.signal);
    }
  }
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
  /** Tracks of the release with no video to fetch. Reported, never downloaded, never failed. */
  let sourceless = 0;
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

    /*
     * A track of the release that no video covers: there is nothing here to download.
     *
     * **First, before every other branch**, because every one of them assumes a video. The
     * row carries `url: null` — it was materialised from the confirmed tracklist, not from a
     * listing (`services/sourceless.ts`) — and `downloadOne` would send that null to the
     * toolbox, get an error back, mark the track `failed`, and fail the step and therefore
     * the album. An album with a nineteen-of-twenty gap would be permanently unimportable,
     * which is the exact defect the sourceless row exists to fix.
     *
     * It is not counted as `skipped` either, and that distinction is deliberate: `skipped`
     * means "already in the library, spared", and this means "waiting for somebody to give it
     * a source". The state stays `sourceless` so the page keeps offering the adoption.
     */
    if (track.state === "sourceless" || track.url === null) {
      sourceless += 1;
      continue;
    }

    /*
     * This import's own file, already filed.
     *
     * Checked before `alreadyInLibrary` and before `fileReady`, because it is the only
     * evidence that survives a worker killed inside `place`: the file has left the work
     * directory — so `fileReady` finds nothing — and the `library_tracks` row that
     * `alreadyInLibrary` reads had not been written yet. `place` records the destination
     * *before* it moves anything precisely so that this line can be believed.
     *
     * The path alone is not taken as proof: `fileOnDisk` insists on a non-empty regular file,
     * so a stale row pointing at a directory or at a zero-byte stub still falls through to a
     * real download.
     *
     * A track found here is past `download` but not necessarily past `place`, so it is handed
     * to `onTrackDownloaded` like any other file that is ready; `nextStepOfTrack` reads the
     * row and sends it to whatever step its state actually calls for — `place` for a track
     * caught in that window, nothing at all for one already filed. Its state is deliberately
     * *not* rewritten to `skipped`: it is mid-pipeline, not spared.
     */
    const filed = force ? null : fileOnDisk(ctx.paths, track.libraryPath);
    if (filed !== null) {
      await ctx.say("track.skipped", `${track.sourceTitle}: already present`, {
        trackId: track.id,
        data: { reason: "already present", path: filed },
      });
      skipped += 1;
      await ctx.onTrackDownloaded?.(track.id);
      continue;
    }

    if (!force && (await alreadyInLibrary(ctx, track.recordingMbid))) {
      // A track *this* import has already filed must not be demoted to `skipped`. Since
      // `place` runs per track (decision 147), a worker restarted mid-album meets its own
      // earlier work in the library, and rewriting `placed` to `skipped` would lose the one
      // fact the aggregate step rows are derived from.
      if (track.state !== "placed" && track.state !== "done") {
        await setTrackState(ctx, track.id, "skipped", { note: "already present" });
      }
      await ctx.say("track.skipped", `${track.sourceTitle}: already present`, {
        trackId: track.id,
        data: { reason: "already present", recordingMbid: track.recordingMbid },
      });
      skipped += 1;
      continue;
    }

    /*
     * A folder import's track: **adopt the file, never fetch it.**
     *
     * This is where "each file is adopted rather than downloaded" actually happens, and it
     * goes through `adoptTrackFile` — the plumbing the single-file work landed — rather than
     * through a copy of it. The whole of the difference between a folder import and a YouTube
     * one is these few lines: the bytes are already on the disk, they are copied into the work
     * directory the way `download` would have left them, and the track carries on at
     * `fingerprint` exactly as if they had been fetched.
     *
     * Placed *after* the "already filed" and "already in the library" checks and *before*
     * `fileReady`, so a re-run of the step is free: a second pass finds the file the first one
     * adopted and falls through to the reuse branch below, which is the same thing a re-run of
     * a real download does. `queue: false` because this loop's own `onTrackDownloaded` is what
     * announces the track, and two announcements would run `fingerprint` twice.
     *
     * A refusal here fails **this track**, not the album: a folder where one file has gone
     * missing since `resolve` listed it must still import the other thirteen, and that is the
     * same contract a failed download has.
     */
    const fromFolder = folderFileOf(track.raw);
    if (fromFolder !== null && fileReady(ctx, track) === null) {
      try {
        // It writes the row, the `mm_adoption` record and the `track.adopted` journal line
        // itself; there is nothing left here to report.
        await adoptTrackFile({
          importId: ctx.job.id,
          trackId: track.id,
          source: { kind: "path", path: fromFolder.path },
          adoptedBy: "folder import",
          db: ctx.db,
          settings: ctx.settings,
          toolbox: ctx.toolbox,
          queue: false,
        });
        reused += 1;
        await ctx.onTrackDownloaded?.(track.id);
      } catch (error) {
        const failure = MMError.from(error);
        await updateTrack(ctx, track.id, { attempts: 1, error: failure.toBody() });
        await setTrackState(ctx, track.id, "failed");
        await ctx.say("track.failed", `${track.sourceTitle}: ${failure.message}`, {
          trackId: track.id,
          level: "error",
          data: { code: failure.code, path: fromFolder.path, adopted: false },
        });
        failures.push({ track: track.sourceTitle, error: failure });
      }
      continue;
    }

    /*
     * `--force` means "fetch it again from the source". An adopted file has no source to fetch
     * again (`services/adopt.ts`): the operator supplied those bytes precisely because the
     * video is gone, age-checked, or was never the point. Re-downloading would overwrite the
     * one copy that exists with a failure — so `force` is honoured for everything except a
     * track whose `raw` carries an adoption record.
     */
    const adopted = adoptionOf(track.raw) !== null;
    const ready = fileReady(ctx, track);
    if (ready !== null && (!force || adopted)) {
      await updateTrack(ctx, track.id, {
        downloadPath: ready,
        downloadedBytes: statSync(hostPath(ctx.paths, ready)).size,
        ...(track.state === "pending" ? { state: "downloaded" as const } : {}),
      });
      await ctx.say(
        "track.skipped",
        `${track.sourceTitle}: ${adopted ? "adopted from a local file" : "already downloaded"}`,
        {
          trackId: track.id,
          data: { reason: adopted ? "adopted" : "already downloaded", path: ready, adopted },
        },
      );
      reused += 1;
      await ctx.onTrackDownloaded?.(track.id);
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
            // Named like every other phase. Without a `stage` the Console's fold has nothing
            // to show and falls back to the word "working" — and since the jitter is longer
            // than the download it precedes, "working" was what the owner's track rows said
            // most of the time. The pause is deliberate (it is what keeps us under YouTube's
            // rate limit), so it should read as a phase, not as an absence of information.
            data: { stage: "pausing", jitterMs: pause },
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

    await ctx.say("track.started", `${track.sourceTitle}: downloading`, {
      trackId: track.id,
      // Named, so the row says "download" from the first instant rather than "working" for
      // the second or two before yt-dlp's first progress line arrives.
      data: { stage: "download", done: downloaded, total: tracks.length },
    });

    let attempt = 0;
    let lastError: MMError | null = null;
    while (attempt < ctx.settings.downloadMaxAttempts) {
      attempt += 1;
      try {
        const size = await downloadOneWhenFree(ctx, track);
        await ctx.say("track.done", `${track.sourceTitle}: downloaded`, {
          trackId: track.id,
          data: { bytes: size, attempt },
        });
        downloaded += 1;
        lastError = null;
        // The file is on disk: `fingerprint`, `tag` and `place` for *this* track can start now,
        // on their own queue, while the loop goes on to the next download (decision 147). This
        // step keeps the single slot and the jitter; it simply stops being the only thing
        // happening. `undefined` outside the worker, so `runImport` stays strictly serial.
        await ctx.onTrackDownloaded?.(track.id);
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

  const summary = { downloaded, reused, skipped, sourceless, failed: failures.length };

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
    message:
      `${String(downloaded)} downloaded, ${String(reused)} reused, ${String(skipped)} already present` +
      // Said out loud, because it is the one number that means "this album is not complete and
      // is waiting for you" rather than "this album is finished".
      (sourceless === 0 ? "" : `, ${String(sourceless)} with no source yet`),
    data: summary,
  };
}
