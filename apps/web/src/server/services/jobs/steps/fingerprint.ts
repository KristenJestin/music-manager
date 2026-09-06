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
  expected: {
    recordingMbid: string | null;
    title: string | null;
    /**
     * What to call the track when the mapping supplied no title.
     *
     * Without it the reason read `the mapping says “”` — true, and useless: the reader cannot
     * tell an empty mapping from a bug in the sentence. The source video's title is what a
     * person would say instead, and it is always there.
     */
    sourceTitle?: string | null;
  },
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
  // `expected.title` is `""` — not null — whenever a caller confirmed a mapping without one,
  // so the empty string has to be excluded explicitly or the sentence reads `says “”`.
  const claimed =
    [expected.title, expected.recordingMbid, expected.sourceTitle].find(
      (value) => value !== null && value !== undefined && value !== "",
    ) ?? "nothing";
  return {
    agrees: false,
    candidateMbid: best?.recording_mbid ?? null,
    candidateTitle: best?.title ?? null,
    score: best?.score ?? null,
    reason: `AcoustID hears “${best?.title ?? best?.recording_mbid ?? "something else"}”, the mapping says “${claimed}”`,
  };
}

/** Every `fingerprint_mismatch` item this import has ever raised, answered or not. */
async function mismatchItems(ctx: StepContext): Promise<{
  /** Track ids whose mismatch has been answered — accepted or dismissed. */
  readonly accepted: Set<string>;
  /** Track ids whose mismatch is still `open`. Nobody has decided about these. */
  readonly open: Set<string>;
}> {
  const rows = await ctx.db
    .select()
    .from(inboxItems)
    .where(and(eq(inboxItems.importId, ctx.job.id), eq(inboxItems.type, "fingerprint_mismatch")));
  const accepted = new Set<string>();
  const open = new Set<string>();
  for (const row of rows) {
    if (row.trackId === null) continue;
    if (row.status === "open") open.add(row.trackId);
    else accepted.add(row.trackId);
  }
  return { accepted, open };
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

  const { accepted } = await mismatchItems(ctx);
  let checked = 0;
  let agreed = 0;
  const disagreements: ImportTrack[] = [];
  /** Tracks whose mismatch stands but could not be re-measured in this pass. */
  const unanswered: ImportTrack[] = [];

  for (const track of tracks) {
    if (aborted(ctx)) {
      return { status: "blocked", blockedAs: "paused", message: "Stopped during fingerprinting." };
    }
    /*
     * No file to re-measure — but that is not the same as "agrees".
     *
     * `place` sets `downloadPath` to null once the track is in the library, so re-running the
     * pipeline over a partly-placed import found nothing to fingerprint, counted zero
     * disagreements and returned `done` — walking straight past open mismatch items. That is
     * how an import finished `done` with five `fingerprint_mismatch` questions still open in
     * the report's own words, "le step est passé sans les attendre". The verdict already
     * recorded on the row is the answer here: a track whose stored verdict is a disagreement
     * and whose question has not been answered still blocks.
     */
    if (track.downloadPath === null || !existsSync(hostPath(ctx.paths, track.downloadPath))) {
      if (track.fingerprintOk === false && !accepted.has(track.id)) unanswered.push(track);
      continue;
    }

    const result = await ctx.toolbox.fingerprint(containerPath(ctx.paths, track.downloadPath));
    checked += 1;

    const verdict = compareFingerprint(
      result,
      {
        recordingMbid: track.recordingMbid,
        title: track.trackTitle,
        sourceTitle: track.sourceTitle,
      },
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

  /*
   * The last word belongs to the Inbox, not to this pass.
   *
   * `open` is re-read here rather than reused from the top, because the loop above may have
   * raised new items. Anything still open — measured in this pass or standing from a previous
   * one — means a human has not decided, and decision 011 is explicit that carrying on would
   * write the wrong tags onto the right file. This is the guarantee "pause on disagreement"
   * was supposed to be and, for a re-run over placed files, was not.
   */
  const stillOpen = (await mismatchItems(ctx)).open;
  const blocking = new Set([
    ...disagreements.map((track) => track.id),
    ...unanswered.map((track) => track.id),
    ...stillOpen,
  ]);

  if (blocking.size > 0) {
    return {
      status: "blocked",
      blockedAs: "awaiting_review",
      message: `${String(blocking.size)} fingerprint mismatch(es) need a decision.`,
      data: {
        checked,
        agreed,
        mismatched: blocking.size,
        // Named apart so the journal says *why* a step blocked without re-measuring anything:
        // these are questions inherited from an earlier pass, not new findings.
        carriedOver: Math.max(0, blocking.size - disagreements.length),
      },
    };
  }

  return {
    status: "done",
    message: `${String(agreed)}/${String(checked)} fingerprints agree with the mapping`,
    data: { checked, agreed },
  };
}
