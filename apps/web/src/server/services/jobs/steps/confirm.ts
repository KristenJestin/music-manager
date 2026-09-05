/**
 * Step 3 — `confirm` (you).
 *
 * The one deliberately **blocking** step of the pipeline. `docs/04-pipeline-et-matching.md`
 * calls it a wizard: release, 1:1 mapping, options. Decision 002 says the algorithm never
 * chooses for you, and a "safe" score of 0.95 marks the first candidate without skipping this
 * gate.
 *
 * Two things unblock it, and only two: `--yes` on the CLI, and fixtures mode — the offline
 * end-to-end run and the demo have nobody to ask. Both are recorded as a `decisions` row with
 * `decidedBy` saying which, so an unattended import is never mistaken for a confirmed one.
 */
import { eq } from "drizzle-orm";
import { decisions, imports } from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import type { StepResult } from "../machine.ts";
import type { StepContext } from "../context.ts";

export async function confirmStep(ctx: StepContext): Promise<StepResult> {
  const mapped = await ctx.mappedTracks();
  const automatic = ctx.job.options.autoConfirm === true || ctx.fixtures;

  if (!automatic) {
    return {
      status: "blocked",
      blockedAs: "awaiting_confirm",
      message: `Waiting for confirmation of ${String(mapped.length)} track(s).`,
      data: {
        releaseMbid: ctx.job.releaseMbid,
        tracks: mapped.map((track) => ({
          position: track.position,
          title: track.sourceTitle,
          trackPosition: track.trackPosition,
          trackTitle: track.trackTitle,
          confidence: track.confidence,
        })),
      },
    };
  }

  const decidedBy = ctx.job.options.autoConfirm === true ? "cli --yes" : "fixtures";
  await ctx.db.insert(decisions).values({
    id: newId("decision"),
    kind: "release",
    importId: ctx.job.id,
    subject: ctx.job.releaseMbid,
    choice: {
      releaseMbid: ctx.job.releaseMbid,
      tracks: mapped.length,
      mapping: mapped.map((track) => ({
        video: track.videoId,
        trackPosition: track.trackPosition,
        recordingMbid: track.recordingMbid,
      })),
    },
    decidedBy,
  });

  await ctx.db.update(imports).set({ updatedAt: new Date() }).where(eq(imports.id, ctx.job.id));

  return {
    status: "done",
    message: `Confirmed automatically (${decidedBy}): ${String(mapped.length)} track(s).`,
    data: { decidedBy, tracks: mapped.length },
  };
}
