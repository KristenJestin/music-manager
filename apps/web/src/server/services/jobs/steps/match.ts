/**
 * Step 2 — `match` (app). **A stub in P03**, as the phase specification says.
 *
 * P05 brings the real thing: scored MusicBrainz candidates, tracklist fit, the global 1:1
 * assignment of `docs/04-pipeline-et-matching.md`. Until then this step only *applies* a
 * mapping that somebody else decided:
 *
 *  - in fixtures mode, the recorded Discovery release — videos 1–14 onto tracks 1–14, video
 *    15 flagged `extra`;
 *  - from the CLI, `--mapping <file.json>`, which is the escape hatch that lets a real URL be
 *    imported before P05 exists.
 *
 * Anything else stops on an `ambiguous_release` Inbox item rather than guessing. A stub that
 * invented a plausible mapping would be worse than one that admits it cannot choose —
 * decision 002 is that the algorithm never chooses for you.
 */
import { eq } from "drizzle-orm";
import { imports } from "#/server/db/schema/index.ts";
import { openInboxItem } from "#/server/services/inbox.ts";
import {
  isDiscoveryFixture,
  matchDiscovery,
  type FixtureMatch,
} from "#/server/services/sources/fixtures.ts";
import type { StepResult } from "../machine.ts";
import { updateTrack, type StepContext } from "../context.ts";

/** A mapping supplied from outside — the CLI's `--mapping`, or a fixture. */
export interface SuppliedMapping {
  readonly releaseMbid: string;
  readonly releaseGroupMbid?: string | null;
  readonly album?: string;
  readonly albumArtist?: string;
  readonly year?: number | null;
  /** Total tracks on the release, so `uncovered_tracks` can be detected. */
  readonly trackTotal?: number;
  readonly tracks: readonly {
    /** Index of the video in the source listing. */
    readonly position: number;
    readonly trackPosition: number;
    readonly mediumPosition?: number;
    readonly trackMbid?: string;
    readonly recordingMbid: string;
    readonly trackTitle: string;
    readonly confidence?: number;
  }[];
}

/** Where a supplied mapping is parked between `mm import --mapping` and this step. */
export function mappingFromOptions(job: {
  options: Record<string, unknown>;
}): SuppliedMapping | null {
  const supplied = job.options["mapping"];
  return supplied === undefined || supplied === null ? null : (supplied as SuppliedMapping);
}

function fromFixture(match: FixtureMatch): SuppliedMapping {
  return {
    releaseMbid: match.releaseMbid,
    releaseGroupMbid: match.releaseGroupMbid,
    album: match.album,
    albumArtist: match.albumArtist,
    year: match.year,
    trackTotal: match.trackTotal,
    tracks: match.mapping.map((entry) => ({
      position: entry.position,
      trackPosition: entry.trackPosition,
      mediumPosition: entry.mediumPosition,
      trackMbid: entry.trackMbid,
      recordingMbid: entry.recordingMbid,
      trackTitle: entry.trackTitle,
      confidence: entry.confidence,
    })),
  };
}

export async function matchStep(ctx: StepContext): Promise<StepResult> {
  const videos = await ctx.tracks();
  const options = ctx.job.options as unknown as Record<string, unknown>;

  const supplied =
    mappingFromOptions({ options }) ??
    (isDiscoveryFixture(ctx.job.url) ? fromFixture(matchDiscovery(videos.length)) : null);

  if (supplied === null) {
    await openInboxItem(
      {
        type: "ambiguous_release",
        importId: ctx.job.id,
        title: `Choose the release for “${ctx.job.title ?? ctx.job.url}”`,
        summary:
          "P03 ships the matcher as a stub. Supply a release and a mapping with " +
          "`mm import --mapping <file.json>`, or wait for the scored candidates of P05.",
        payload: { url: ctx.job.url, videos: videos.length },
      },
      ctx.db,
    );
    return {
      status: "blocked",
      blockedAs: "awaiting_review",
      message: "No mapping available: the matcher is a stub until P05.",
    };
  }

  const byPosition = new Map(supplied.tracks.map((entry) => [entry.position, entry]));
  let mapped = 0;
  let extras = 0;

  for (const video of videos) {
    const hit = byPosition.get(video.position);
    if (hit === undefined) {
      await updateTrack(ctx, video.id, {
        role: "extra",
        trackMbid: null,
        recordingMbid: null,
        trackTitle: null,
        trackPosition: null,
        mediumPosition: null,
        confidence: null,
      });
      extras += 1;
      continue;
    }
    await updateTrack(ctx, video.id, {
      role: "mapped",
      trackMbid: hit.trackMbid ?? null,
      recordingMbid: hit.recordingMbid,
      trackTitle: hit.trackTitle,
      trackPosition: hit.trackPosition,
      mediumPosition: hit.mediumPosition ?? 1,
      confidence: hit.confidence ?? 1,
    });
    mapped += 1;
  }

  await ctx.db
    .update(imports)
    .set({
      releaseMbid: supplied.releaseMbid,
      releaseGroupMbid: supplied.releaseGroupMbid ?? null,
      ...(supplied.album === undefined ? {} : { title: supplied.album }),
      ...(supplied.albumArtist === undefined ? {} : { artist: supplied.albumArtist }),
      ...(supplied.year === undefined || supplied.year === null ? {} : { year: supplied.year }),
      updatedAt: new Date(),
    })
    .where(eq(imports.id, ctx.job.id));

  // The videos nobody claimed are the `extra_videos` case of `docs/04` § Inbox. It is a
  // notice, not a gate: the album can be imported without them.
  if (extras > 0) {
    const leftovers = videos.filter((video) => !byPosition.has(video.position));
    await openInboxItem(
      {
        type: "extra_videos",
        importId: ctx.job.id,
        title: `${String(extras)} video(s) outside the tracklist`,
        summary: leftovers.map((video) => video.sourceTitle).join(", "),
        payload: {
          videos: leftovers.map((video) => ({
            id: video.id,
            position: video.position,
            title: video.sourceTitle,
          })),
        },
        preselected: { action: "ignore" },
      },
      ctx.db,
    );
  }

  // A track of the release that no video covers: `uncovered_tracks`. Also a notice — the
  // album is simply incomplete, which is exactly what the Inbox item is for.
  const covered = new Set(supplied.tracks.map((entry) => entry.trackPosition));
  const uncovered =
    supplied.trackTotal === undefined
      ? []
      : Array.from({ length: supplied.trackTotal }, (_, index) => index + 1).filter(
          (position) => !covered.has(position),
        );
  if (uncovered.length > 0) {
    await openInboxItem(
      {
        type: "uncovered_tracks",
        importId: ctx.job.id,
        title: `${String(uncovered.length)} track(s) of the release have no video`,
        summary: `Positions ${uncovered.join(", ")}.`,
        payload: { positions: uncovered, releaseMbid: supplied.releaseMbid },
        preselected: { action: "import anyway" },
      },
      ctx.db,
    );
  }

  return {
    status: "done",
    message: `${String(mapped)} track(s) mapped, ${String(extras)} extra`,
    data: { releaseMbid: supplied.releaseMbid, mapped, extras },
  };
}
