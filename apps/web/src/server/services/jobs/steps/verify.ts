/**
 * Step 8 — `verify` (app). **A stub in P03**, as the phase specification says.
 *
 * The real verification is decision 009 and P07: rescan Navidrome, then read every track back
 * through OpenSubsonic, because what a client displays is the only proof that matters. That
 * needs a running server and a scan cycle, neither of which belongs in this phase.
 *
 * What it does here is the one check that costs nothing and still catches the failure mode
 * that would otherwise go unnoticed: the file the database claims to have placed is on disk
 * and is not empty. A `library_tracks` row pointing at nothing is worse than no row.
 */
import { existsSync, statSync } from "node:fs";
import { eq } from "drizzle-orm";
import { libraryTracks } from "#/server/db/schema/index.ts";
import { hostPath } from "#/server/paths.ts";
import type { StepResult } from "../machine.ts";
import { updateTrack, type StepContext } from "../context.ts";

export async function verifyStep(ctx: StepContext): Promise<StepResult> {
  const tracks = await ctx.mappedTracks();
  const placed = tracks.filter((track) => track.libraryPath !== null);

  if (placed.length === 0) {
    return { status: "skipped", message: "Nothing was placed, so there is nothing to verify." };
  }

  const missing: string[] = [];
  let bytes = 0;

  for (const track of placed) {
    const relative = track.libraryPath;
    if (relative === null) continue;
    const absolute = hostPath(ctx.paths, relative);
    const present = existsSync(absolute) && statSync(absolute).size > 0;
    if (!present) {
      missing.push(relative);
      continue;
    }
    const size = statSync(absolute).size;
    bytes += size;
    await ctx.db
      .update(libraryTracks)
      .set({
        verifiedAt: new Date(),
        verifyResult: { method: "exists", ok: true, size },
        updatedAt: new Date(),
      })
      .where(eq(libraryTracks.path, relative));
    if (track.state !== "done") await updateTrack(ctx, track.id, { state: "done" });
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

  return {
    status: "done",
    message: `${String(placed.length)} file(s) present (${(bytes / 1024 / 1024).toFixed(1)} MiB). Navidrome read-back arrives in P07.`,
    data: { verified: placed.length, bytes, method: "exists" },
  };
}
