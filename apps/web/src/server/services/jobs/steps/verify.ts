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
import { eq } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { libraryTracks } from "#/server/db/schema/index.ts";
import { hostPath } from "#/server/paths.ts";
import { navidromeConfig } from "#/server/services/navidrome.ts";
import { verifyAlbum, type AlbumVerification } from "#/server/services/verify.ts";
import type { StepResult } from "../machine.ts";
import type { StepContext } from "../context.ts";

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
    return {
      status: "failed",
      message: `${String(missing.length)} placed file(s) are missing from the library.`,
      data: { missing },
      error: {
        code: "STEP_FAILED",
        message: `Missing: ${missing.slice(0, 3).join(", ")}`,
        hint: "Something moved or deleted the files after they were placed.",
        action: "Retry the import",
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
