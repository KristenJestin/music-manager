/**
 * Step 5 — `fingerprint` (toolbox + app).
 *
 * Decision 011: the fingerprint is a **safety net, not a gate**. It runs after the download,
 * it never picks the match, and the only thing it can do is stop the job when the audio
 * disagrees with the mapping — which is precisely the case where carrying on would write the
 * wrong tags onto the right file, the most expensive kind of mistake this app can make.
 *
 * The comparison accepts a candidate on either identifier the two sides can share: the
 * recording MBID when AcoustID and the mapping speak the same namespace, or a normalised
 * title above `titleMatchThreshold`. A disagreement opens one `fingerprint_mismatch` item per
 * track and pauses the import in `awaiting_review`; `mm inbox resolve <id> --accept` records
 * the decision, and re-running this step then walks past it.
 */
import { and, eq } from "drizzle-orm";
import { normalizeTitle, titleSimilarity } from "@mm/domain";
import { inboxItems, type ImportTrack } from "#/server/db/schema/index.ts";
import { hostPath } from "#/server/paths.ts";
import { containerPath } from "#/server/paths.ts";
import { openInboxItem } from "#/server/services/inbox.ts";
import type { FingerprintResult } from "#/server/toolbox/client.ts";
import type { StepResult } from "../machine.ts";
import { aborted, updateTrack, type StepContext } from "../context.ts";
import { existsSync } from "node:fs";

/** States in which a track has a file worth fingerprinting. */
const HAS_FILE = new Set(["downloaded", "fingerprinted", "tagged", "placed", "done"]);

export interface Verdict {
  readonly agrees: boolean;
  readonly candidateMbid: string | null;
  readonly candidateTitle: string | null;
  readonly score: number | null;
  readonly reason: string;
}

/**
 * Does what AcoustID heard match what the mapping claims?
 *
 * Pure, and exported, because this is the judgement the whole step exists for: it deserves a
 * test of its own rather than only being exercised through Postgres and Docker.
 */
export function compareFingerprint(
  result: Pick<FingerprintResult, "candidates">,
  expected: { recordingMbid: string | null; title: string | null },
  options: { minScore: number; titleThreshold: number },
): Verdict {
  const candidates = (result.candidates ?? []).filter(
    (candidate) => candidate.score >= options.minScore,
  );
  if (candidates.length === 0) {
    // No key, no answer, or only noise: nothing was measured, so nothing is contradicted.
    return {
      agrees: true,
      candidateMbid: null,
      candidateTitle: null,
      score: null,
      reason: "no AcoustID candidate above the score floor",
    };
  }

  for (const candidate of candidates) {
    if (
      expected.recordingMbid !== null &&
      expected.recordingMbid !== "" &&
      candidate.recording_mbid === expected.recordingMbid
    ) {
      return {
        agrees: true,
        candidateMbid: candidate.recording_mbid,
        candidateTitle: candidate.title ?? null,
        score: candidate.score,
        reason: "recording MBID matches",
      };
    }
  }

  // The MBIDs may simply live in different namespaces (an AcoustID answer versus a release
  // lookup, or two fixture sets). Fall back on the title, which is what a human would read.
  if (expected.title !== null && expected.title !== "") {
    for (const candidate of candidates) {
      if (candidate.title == null) continue;
      const similarity = titleSimilarity(candidate.title, expected.title);
      if (similarity >= options.titleThreshold) {
        return {
          agrees: true,
          candidateMbid: candidate.recording_mbid,
          candidateTitle: candidate.title,
          score: candidate.score,
          reason: `title matches (${similarity.toFixed(2)})`,
        };
      }
    }
  }

  const best = candidates[0];
  return {
    agrees: false,
    candidateMbid: best?.recording_mbid ?? null,
    candidateTitle: best?.title ?? null,
    score: best?.score ?? null,
    reason: `AcoustID hears “${best?.title ?? best?.recording_mbid ?? "something else"}”, the mapping says “${expected.title ?? expected.recordingMbid ?? "?"}”`,
  };
}

/** Track ids whose mismatch has already been answered. */
async function acceptedMismatches(ctx: StepContext): Promise<Set<string>> {
  const rows = await ctx.db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.importId, ctx.job.id), eq(inboxItems.type, "fingerprint_mismatch")));
  const accepted = new Set<string>();
  for (const row of rows) {
    if (row.status !== "open" && row.trackId !== null) accepted.add(row.trackId);
  }
  return accepted;
}

export async function fingerprintStep(ctx: StepContext): Promise<StepResult> {
  if (!ctx.settings.verifyFingerprint && ctx.job.options.fingerprint !== true) {
    return { status: "skipped", message: "fingerprint verification is off" };
  }
  if (ctx.job.options.fingerprint === false) {
    return { status: "skipped", message: "fingerprint disabled for this import" };
  }

  const tracks = (await ctx.mappedTracks()).filter((track) => HAS_FILE.has(track.state));
  if (tracks.length === 0) {
    return { status: "skipped", message: "No downloaded track to fingerprint." };
  }

  const accepted = await acceptedMismatches(ctx);
  let checked = 0;
  let agreed = 0;
  const disagreements: ImportTrack[] = [];

  for (const track of tracks) {
    if (aborted(ctx)) {
      return { status: "blocked", blockedAs: "paused", message: "Stopped during fingerprinting." };
    }
    if (track.downloadPath === null) continue;
    if (!existsSync(hostPath(ctx.paths, track.downloadPath))) continue;

    const result = await ctx.toolbox.fingerprint(containerPath(ctx.paths, track.downloadPath));
    checked += 1;

    const verdict = compareFingerprint(
      result,
      { recordingMbid: track.recordingMbid, title: track.trackTitle },
      {
        minScore: ctx.settings.fingerprintMinScore,
        titleThreshold: ctx.settings.titleMatchThreshold,
      },
    );

    await updateTrack(ctx, track.id, {
      fingerprint: result.fingerprint,
      fingerprintDuration: result.duration,
      acoustidMbid: verdict.candidateMbid,
      fingerprintOk: verdict.agrees,
      ...(track.state === "downloaded" ? { state: "fingerprinted" as const } : {}),
    });

    if (verdict.agrees || accepted.has(track.id)) {
      agreed += 1;
      if (!verdict.agrees) {
        await ctx.say("track.progress", `${track.sourceTitle}: mismatch accepted`, {
          trackId: track.id,
          data: { acceptedMismatch: true, ...verdict },
        });
      }
      continue;
    }

    disagreements.push(track);
    await openInboxItem(
      {
        type: "fingerprint_mismatch",
        importId: ctx.job.id,
        trackId: track.id,
        title: `Fingerprint disagrees on “${track.sourceTitle}”`,
        summary: verdict.reason,
        payload: {
          video: track.videoId,
          expected: { recordingMbid: track.recordingMbid, title: track.trackTitle },
          heard: {
            recordingMbid: verdict.candidateMbid,
            title: verdict.candidateTitle,
            score: verdict.score,
          },
          normalisedExpected: normalizeTitle(track.trackTitle ?? ""),
        },
        preselected: { action: "accept", reason: "keep the mapping and carry on" },
      },
      ctx.db,
    );
  }

  if (disagreements.length > 0) {
    return {
      status: "blocked",
      blockedAs: "awaiting_review",
      message: `${String(disagreements.length)} fingerprint mismatch(es) need a decision.`,
      data: { checked, agreed, mismatched: disagreements.length },
    };
  }

  return {
    status: "done",
    message: `${String(agreed)}/${String(checked)} fingerprints agree with the mapping`,
    data: { checked, agreed },
  };
}
