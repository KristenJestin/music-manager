/**
 * Step 8 — `verify` (app). The read-back of `docs/03-metadonnees.md` §7 and decision 009.
 *
 * Two checks, in that order, because they answer two different questions:
 *
 *  1. **Are the files there?** A `library_tracks` row pointing at nothing is worse than no
 *     row at all, and this costs one `stat` per track. It runs whatever else is configured.
 *  2. **Does the server see the tags?** Only a consumer's own API can answer that — what
 *     Feishin and Symfonium display is the only definition of "the tag arrived". So the step
 *     asks Navidrome to scan, waits for it, reads the album back through OpenSubsonic and
 *     compares field by field against the projection we handed the toolbox.
 *
 * The second check is **not a gate**. A Navidrome that is switched off, unreachable or simply
 * has not scanned yet must not fail an import whose files are on disk and correct: the step
 * records what it learned, opens a `verify_mismatch` item when a *required* field genuinely
 * came back wrong, and finishes `done`. An import that fails because a music server was
 * rebooting would teach the operator to distrust the pipeline for no reason.
 */
import { existsSync, statSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { jobSteps, libraryTracks } from "#/server/db/schema/index.ts";
import { hostPath } from "#/server/paths.ts";
import { navidromeConfig } from "#/server/services/navidrome.ts";
import { verifyAlbum, type AlbumVerification } from "#/server/services/verify.ts";
import type { StepResult } from "../machine.ts";
import { updateTrack, type StepContext } from "../context.ts";

/** How many times a placed file that vanished may be downloaded again before giving up. */
const MAX_REDOWNLOADS = 2;

export async function verifyStep(ctx: StepContext): Promise<StepResult> {
  const tracks = await ctx.mappedTracks();
  const placed = tracks.filter((track) => track.libraryPath !== null);

  if (placed.length === 0) {
    return { status: "skipped", message: "Nothing was placed, so there is nothing to verify." };
  }

  /* ---- 1. the files are on disk ---- */

  const missing: string[] = [];
  const albumIds = new Set<string>();
  let bytes = 0;

  for (const track of placed) {
    const relative = track.libraryPath;
    if (relative === null) continue;
    const absolute = hostPath(ctx.paths, relative);
    if (!existsSync(absolute) || statSync(absolute).size === 0) {
      missing.push(relative);
      continue;
    }
    const size = statSync(absolute).size;
    bytes += size;
    const [row] = await ctx.db
      .update(libraryTracks)
      .set({
        verifiedAt: new Date(),
        verifyResult: { method: "exists", ok: true, size },
        updatedAt: new Date(),
      })
      .where(eq(libraryTracks.path, relative))
      .returning({ albumId: libraryTracks.albumId });
    if (row?.albumId != null) albumIds.add(row.albumId);
  }

  if (missing.length > 0) {
    // Two rewinds and no more. A file that vanishes again the moment it is written is a disk,
    // a sync client or an antivirus — something a third download will not fix, and an
    // orchestrator that keeps trying is a loop nobody asked for.
    const [row] = await ctx.db
      .select({ attempt: jobSteps.attempt })
      .from(jobSteps)
      .where(and(eq(jobSteps.importId, ctx.job.id), eq(jobSteps.step, "verify")))
      .limit(1);
    const giveUp = (row?.attempt ?? 1) > MAX_REDOWNLOADS;

    /*
     * A file that was placed and is no longer there is a track to fetch again, not an import
     * to abandon (owner review C6). The owner's CHVRCHES run stopped here with
     * `STEP_FAILED — Missing: … 04 My Enemy.opus`, and every Retry re-ran `verify`, found the
     * same hole and failed again — because `resumePoint` restarts at the first step that is
     * not done, and `verify` was it.
     *
     * So put the affected tracks back to "not downloaded", drop the `library_tracks` rows that
     * point at nothing, and ask the machine to rewind to `download`. The mapping, the
     * documents and the twelve files that *are* there are untouched: `download` skips a track
     * whose file is on disk, so exactly the hole is refilled.
     */
    for (const track of placed) {
      if (giveUp) break;
      const relative = track.libraryPath;
      if (relative === null || !missing.includes(relative)) continue;
      await ctx.db.delete(libraryTracks).where(eq(libraryTracks.path, relative));
      await updateTrack(ctx, track.id, {
        state: "pending",
        libraryPath: null,
        downloadPath: null,
        downloadedBytes: null,
        error: null,
        note: "the placed file had disappeared; downloading it again",
      });
      await ctx.say("track.progress", `${track.sourceTitle}: file gone, downloading it again`, {
        trackId: track.id,
        level: "warn",
        data: { stage: "missing", path: relative },
      });
    }
    return {
      status: "failed",
      ...(giveUp ? {} : { restartAt: "download" as const }),
      message: giveUp
        ? `${String(missing.length)} placed file(s) are missing and came back missing after ${String(MAX_REDOWNLOADS)} download(s).`
        : `${String(missing.length)} placed file(s) had disappeared; downloading them again.`,
      data: { missing, restarted: giveUp ? 0 : missing.length },
      error: {
        code: "STEP_FAILED",
        message: `Missing: ${missing.slice(0, 3).join(", ")}`,
        hint: giveUp
          ? "The files were downloaded again and disappeared again: something outside this app is removing them."
          : "Something moved or deleted the files after they were placed.",
        action: giveUp ? "Check the library directory" : "Nothing — the job is fetching them again",
      },
    };
  }

  const onDisk = `${String(placed.length)} file(s) present (${(bytes / 1024 / 1024).toFixed(1)} MiB)`;

  /* ---- 2. the server sees them ---- */

  const navidrome = navidromeConfig(ctx.settings);
  if (!navidrome.enabled) {
    return {
      status: "done",
      message: `${onDisk}. Navidrome read-back is off, so nothing was compared.`,
      data: { verified: placed.length, bytes, method: "exists", readBack: false },
    };
  }

  const results: Record<string, AlbumVerification> = {};
  const problems: string[] = [];
  let rescan = ctx.settings.navidromeRescanOnVerify;

  for (const albumId of albumIds) {
    try {
      const verification = await verifyAlbum(albumId, {
        db: ctx.db,
        settings: ctx.settings,
        rescan,
        ...(ctx.signal === undefined ? {} : { signal: ctx.signal }),
        say: async (message, data) => {
          await ctx.say("verify.progress", message, data === undefined ? {} : { data });
        },
      });
      // One scan is enough for the whole import: the second album is already indexed.
      rescan = false;
      results[albumId] = verification;
      if (verification.note !== null) problems.push(verification.note);
      else if (verification.requiredMismatches.length > 0) {
        problems.push(
          `${verification.requiredMismatches.length} required field(s) differ: ${verification.requiredMismatches.join(", ")}`,
        );
      }
      await ctx.say(
        "verify.album",
        verification.note ??
          `Read back ${String(verification.fields.length)} fields: ${String(verification.ok)} ok, ${String(verification.mismatches)} mismatch, ${String(verification.notIndexed)} not indexed.`,
        {
          level: verification.requiredMismatches.length > 0 ? "warn" : "info",
          data: { albumId, ...verification },
        },
      );
    } catch (error) {
      // Unreachable, wrong password, scan timeout: worth saying, never worth failing on.
      const failure = MMError.from(error);
      problems.push(failure.message);
      await ctx.say("verify.failed", `Navidrome read-back did not run: ${failure.message}`, {
        level: "warn",
        data: { albumId, code: failure.code },
      });
    }
  }

  const compared = Object.values(results);
  const summary =
    compared.length === 0
      ? `${onDisk}. The read-back did not produce a comparison.`
      : `${onDisk}; read back ${String(compared.reduce((total, entry) => total + entry.fields.length, 0))} field(s) across ${String(compared.length)} album(s), ${String(compared.reduce((total, entry) => total + entry.mismatches, 0))} mismatch(es).`;

  return {
    status: "done",
    message: problems.length === 0 ? summary : `${summary} ${problems[0] ?? ""}`.trim(),
    data: {
      verified: placed.length,
      bytes,
      method: "opensubsonic",
      readBack: true,
      albums: results,
      problems,
    },
  };
}
