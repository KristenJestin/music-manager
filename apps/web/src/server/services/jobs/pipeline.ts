/**
 * Per-track pipelining: the half of the machine that runs one *track* rather than one import.
 *
 * `docs/04-pipeline-et-matching.md` § Étapes gives eight steps in order, and until now the
 * runner read that order as "every track through `download`, then every track through
 * `fingerprint`, then every track through `tag`…". That is not what the order says. It says a
 * *track* is downloaded, then fingerprinted, then tagged, then filed; nothing in it requires
 * track 2's download to wait for track 1's placement, and on a fourteen-track album that
 * reading cost minutes of a machine doing nothing while yt-dlp slept out its jitter.
 *
 * So the pipeline is split in two (decision 147):
 *
 *  - **`download` stays exactly as strict as it was.** One pg-boss `singleton` queue, one
 *    consumer, one toolbox slot, the same 5–15 s jitter between two files. Nothing here makes
 *    a second download possible, and the integration test asserts that in the queue's own
 *    ledger rather than by reading this comment.
 *  - **`fingerprint`, `tag` and `place` become per-track jobs** on the `track.step` queue, with
 *    a small concurrency. Track N's file is handed over the instant it lands, and its local
 *    work overlaps track N+1's download.
 *
 * Three invariants hold the result together:
 *
 *  1. **Order per track is total.** A track's next step is a pure function of its own
 *     `import_tracks.state` (`nextTrackStep`), and one message is enqueued at a time, so
 *     `tag` can never overtake `fingerprint` for the same row however wide the concurrency is.
 *  2. **`import_tracks.state` is the ledger.** Nothing about "how far is this album" lives in
 *     a worker; the `job_steps` rows for the three pipelined steps are *derived* from the track
 *     states (`syncLocalSteps`), which is what keeps `queueStanding` — and therefore the head
 *     step and `queuePosition` the API publishes — true without a second source.
 *  3. **A track that stops does not stop the album.** A fingerprint disagreement pauses that
 *     track and nothing else; a failure marks that track and nothing else. The import as a
 *     whole is only concluded by `settleImport`, once every other track has finished.
 */
import { and, asc, eq } from "drizzle-orm";
import { MMError } from "@mm/contracts";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import {
  importTracks,
  imports,
  inboxItems,
  jobSteps,
  type ImportTrack,
  type StepName,
  type StepStatus,
  type TrackState,
} from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { emit } from "#/server/services/events.ts";
import {
  aggregateStatus,
  hasPassed,
  isTerminal,
  isTrackTerminal,
  LOCAL_STEPS,
  nextTrackStep,
  STEP_ORDER,
  type LocalStep,
  type StepResult,
} from "./machine.ts";
import { makeContext, requireImport, type ContextOptions, type StepContext } from "./context.ts";
import { fingerprintStep } from "./steps/fingerprint.ts";
import { tagStep } from "./steps/tag.ts";
import { placeStep } from "./steps/place.ts";

export {
  aggregateStatus,
  hasPassed,
  isLocalStep,
  isTrackTerminal,
  LOCAL_STEPS,
  nextTrackStep,
  type LocalStep,
} from "./machine.ts";

const LOCAL_FUNCTIONS: Record<LocalStep, (ctx: StepContext) => Promise<StepResult>> = {
  fingerprint: fingerprintStep,
  tag: tagStep,
  place: placeStep,
};

/** The state a track is in once it has passed the step, when it was not already past it. */
const REACHED: Record<LocalStep, TrackState> = {
  fingerprint: "fingerprinted",
  tag: "tagged",
  place: "placed",
};

async function upsertStepRow(
  db: Database,
  importId: string,
  step: StepName,
  patch: { status: StepStatus; message: string | null; result?: Record<string, unknown> | null },
): Promise<void> {
  const [existing] = await db
    .select({ id: jobSteps.id, attempt: jobSteps.attempt })
    .from(jobSteps)
    .where(and(eq(jobSteps.importId, importId), eq(jobSteps.step, step)))
    .limit(1);

  const finished = patch.status === "done" || patch.status === "skipped";
  if (existing === undefined) {
    await db.insert(jobSteps).values({
      id: newId("jobStep"),
      importId,
      step,
      status: patch.status,
      attempt: 1,
      startedAt: new Date(),
      ...(finished ? { finishedAt: new Date() } : {}),
      message: patch.message,
      ...(patch.result === undefined ? {} : { result: patch.result }),
    });
    return;
  }
  await db
    .update(jobSteps)
    .set({
      status: patch.status,
      message: patch.message,
      finishedAt: finished ? new Date() : null,
      ...(patch.result === undefined ? {} : { result: patch.result }),
      updatedAt: new Date(),
    })
    .where(eq(jobSteps.id, existing.id));
}

/** Every mapped video of an import, in tracklist order. */
export async function mappedTracksOf(db: Database, importId: string): Promise<ImportTrack[]> {
  return await db
    .select()
    .from(importTracks)
    .where(and(eq(importTracks.importId, importId), eq(importTracks.role, "mapped")))
    .orderBy(asc(importTracks.trackPosition));
}

/**
 * The local step one track needs next, read from its row.
 *
 * `download` calls this through `onTrackDownloaded` rather than assuming `fingerprint`: a
 * download step that runs a second time — a Retry pressed mid-album, a resume — walks the
 * whole tracklist and re-announces every file it finds. Announcing them all at `fingerprint`
 * would put a second chain behind a track that is already being tagged; asking the row instead
 * means a track that needs nothing is announced as nothing.
 */
export async function nextStepOfTrack(db: Database, trackId: string): Promise<LocalStep | null> {
  const [row] = await db
    .select({ state: importTracks.state })
    .from(importTracks)
    .where(eq(importTracks.id, trackId))
    .limit(1);
  return row === undefined ? null : nextTrackStep(row.state);
}

/** Track ids of this import with an unanswered `fingerprint_mismatch`. */
export async function openMismatches(db: Database, importId: string): Promise<Set<string>> {
  const rows = await db
    .select({ trackId: inboxItems.trackId })
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.importId, importId),
        eq(inboxItems.type, "fingerprint_mismatch"),
        eq(inboxItems.status, "open"),
      ),
    );
  const open = new Set<string>();
  for (const row of rows) if (row.trackId !== null) open.add(row.trackId);
  return open;
}

/**
 * Rewrite the three pipelined `job_steps` rows from the track states, then point
 * `imports.step` at the first step the machine has not finished.
 *
 * This is the "statut d'import agrégé" of the owner's D5, and it is a projection rather than a
 * second bookkeeping: `queueStanding` already defines the head step as the first unfinished
 * `job_steps` row, so keeping those rows true is all that `get_import`, the Console header and
 * `queuePosition` need.
 */
export async function syncLocalSteps(
  db: Database,
  importId: string,
  tracks?: readonly ImportTrack[],
): Promise<StepName> {
  const rows = tracks ?? (await mappedTracksOf(db, importId));
  for (const step of LOCAL_STEPS) {
    const tally = aggregateStatus(rows, step);
    // `tag` is closed by its own album-wide tail (`tagAlbum`), never here: ReplayGain and the
    // album-scope fields are not knowable per track, so "every track tagged" is not "the album
    // is tagged". Marking it `done` here would let `verify` read files whose ALBUMGAIN and
    // GENRE had not been written yet.
    const status: StepStatus = step === "tag" && tally.status === "done" ? "running" : tally.status;
    if (status === "pending") continue;
    await upsertStepRow(db, importId, step, {
      status,
      message:
        status === "skipped"
          ? "nothing to do"
          : `${String(tally.done)}/${String(tally.total)} track(s)`,
    });
  }
  return await refreshHeadStep(db, importId);
}

/** The first step of the machine whose row is not `done`/`skipped`. */
export async function headStepOf(db: Database, importId: string): Promise<StepName> {
  const rows = await db
    .select({ step: jobSteps.step, status: jobSteps.status })
    .from(jobSteps)
    .where(eq(jobSteps.importId, importId));
  const byStep = new Map(rows.map((row) => [row.step, row.status]));
  for (const step of STEP_ORDER) {
    const status = byStep.get(step);
    if (status !== "done" && status !== "skipped") return step;
  }
  return "verify";
}

/** Write the head step onto the import, leaving its status alone. */
async function refreshHeadStep(db: Database, importId: string): Promise<StepName> {
  const head = await headStepOf(db, importId);
  await db
    .update(imports)
    .set({ step: head, updatedAt: new Date() })
    .where(eq(imports.id, importId));
  return head;
}

/* ------------------------------------------------------------------ */
/* one step of one track                                               */
/* ------------------------------------------------------------------ */

export interface TrackStepOutcome {
  readonly result: StepResult;
  /** The step this track wants next, or `null` when it has nothing left to do. */
  readonly next: LocalStep | null;
  /** True when the track stopped on a question or a failure rather than finishing. */
  readonly stopped: boolean;
}

/**
 * Run one pipelined step for one track, with its bookkeeping.
 *
 * The step implementations are untouched: they read `ctx.mappedTracks()`, which the scoped
 * context narrows to this one row. What changes is what happens around them — the aggregate
 * `job_steps` rows are derived afterwards, and neither a failure nor a blocked question is
 * allowed to write `imports.status`: that is `settleImport`'s decision, once the album is
 * otherwise finished, so a mismatch on track 3 cannot hold up the download of track 4.
 */
export async function runTrackStep(
  importId: string,
  trackId: string,
  step: LocalStep,
  options: ContextOptions = {},
): Promise<TrackStepOutcome> {
  const db = options.db ?? defaultDb();

  const job = await requireImport(importId, db);
  if (isTerminal(job.status) || job.status === "paused") {
    const message = `${step} skipped: the job is ${job.status}`;
    await emit({ importId, trackId, step, type: "step.skipped", message }, db);
    return { result: { status: "skipped", message }, next: null, stopped: true };
  }

  const [track] = await db
    .select()
    .from(importTracks)
    .where(and(eq(importTracks.id, trackId), eq(importTracks.importId, importId)))
    .limit(1);
  if (track === undefined || isTrackTerminal(track.state)) {
    return { result: { status: "skipped", message: "nothing to do" }, next: null, stopped: true };
  }
  // A message that arrived twice, or out of order after a resume: the row already says the
  // track is past this step, so run whatever it actually needs instead of redoing work.
  if (hasPassed(track.state, step)) {
    return {
      result: { status: "skipped", message: `${step} already done for this track` },
      next: nextTrackStep(track.state),
      stopped: false,
    };
  }

  const ctx = await makeContext(importId, step, { ...options, trackId });

  let result: StepResult;
  try {
    result = await LOCAL_FUNCTIONS[step](ctx);
  } catch (error) {
    const failure = MMError.from(error);
    result = { status: "failed", message: failure.message, error: failure.toBody() };
  }

  if (result.status === "done" || result.status === "skipped") {
    // The step implementations advance the state themselves when they do work; a `skipped`
    // one does not, and a track that stayed at `downloaded` because fingerprinting is off
    // would be handed the same step for ever. The ledger moves either way.
    const [after] = await db
      .select({ state: importTracks.state })
      .from(importTracks)
      .where(eq(importTracks.id, trackId))
      .limit(1);
    const state = after?.state ?? track.state;
    if (!isTrackTerminal(state) && !hasPassed(state, step)) {
      await db
        .update(importTracks)
        .set({ state: REACHED[step], updatedAt: new Date() })
        .where(eq(importTracks.id, trackId));
    }
  } else if (result.status === "failed") {
    await db
      .update(importTracks)
      .set({ state: "failed", error: result.error ?? null, updatedAt: new Date() })
      .where(eq(importTracks.id, trackId));
    await emit(
      {
        importId,
        trackId,
        step,
        level: "error",
        type: "track.failed",
        message: result.message ?? `${step} failed`,
        data: { ...(result.error ?? {}) },
      },
      db,
    );
  }

  const [current] = await db
    .select({ state: importTracks.state })
    .from(importTracks)
    .where(eq(importTracks.id, trackId))
    .limit(1);
  const state = current?.state ?? track.state;

  await syncLocalSteps(db, importId);

  const stopped = result.status === "blocked" || result.status === "failed";
  return { result, next: stopped ? null : nextTrackStep(state), stopped };
}

/* ------------------------------------------------------------------ */
/* concluding the album                                                */
/* ------------------------------------------------------------------ */

export type Settlement =
  /** Some track still has work to do, or `download` has not finished. Nothing to decide yet. */
  | { readonly action: "wait" }
  /** Every track is filed: run the album-wide tail of `tag`, then `verify`. */
  | { readonly action: "finish" }
  /** Everything else is done and a fingerprint question is still open. */
  | { readonly action: "review"; readonly tracks: number }
  /** Everything else is done and at least one track gave up. */
  | { readonly action: "failed"; readonly tracks: number };

/**
 * What should happen to the import now that one track has finished its chain.
 *
 * Called after every per-track step and at the end of `download`. It is deliberately a *read*
 * that returns a decision: the caller — the worker — is the only thing allowed to put a
 * message on a queue, and keeping the judgement here means the CLI, the tests and the worker
 * cannot disagree about when an album is over.
 */
export async function settleImport(db: Database, importId: string): Promise<Settlement> {
  const [download] = await db
    .select({ status: jobSteps.status })
    .from(jobSteps)
    .where(and(eq(jobSteps.importId, importId), eq(jobSteps.step, "download")))
    .limit(1);
  const downloadOver = download?.status === "done" || download?.status === "skipped";
  if (!downloadOver) return { action: "wait" };

  const tracks = await mappedTracksOf(db, importId);
  const open = await openMismatches(db, importId);

  const busy = tracks.filter(
    (track) =>
      !isTrackTerminal(track.state) && nextTrackStep(track.state) !== null && !open.has(track.id),
  );
  if (busy.length > 0) return { action: "wait" };

  const failed = tracks.filter((track) => track.state === "failed");
  if (failed.length > 0) return { action: "failed", tracks: failed.length };
  if (open.size > 0) return { action: "review", tracks: open.size };
  return { action: "finish" };
}

/**
 * Stop the import on a fingerprint question, without touching anything else.
 *
 * The import rests *on* `fingerprint`, which is where a resume re-runs it — the same contract
 * `transition()` gives a blocked step. The difference is only in when it happens: the album
 * finished downloading and filing everything it could first, which is the point of D5.
 */
export async function pauseForReview(db: Database, importId: string, count: number): Promise<void> {
  const message = `${String(count)} fingerprint mismatch(es) need a decision.`;
  await upsertStepRow(db, importId, "fingerprint", { status: "blocked", message });
  await db
    .update(imports)
    .set({ step: "fingerprint", status: "awaiting_review", updatedAt: new Date() })
    .where(eq(imports.id, importId));
  await emit(
    {
      importId,
      step: "fingerprint",
      level: "warn",
      type: "import.status",
      message: `awaiting_review: ${message}`,
      data: { step: "fingerprint", status: "awaiting_review", mismatched: count },
    },
    db,
  );
}

/** The transition a failed track deserves once every other track has finished. */
export async function failSettled(
  db: Database,
  importId: string,
  count: number,
): Promise<{ step: StepName; result: StepResult }> {
  const tracks = await mappedTracksOf(db, importId);
  const broken = tracks.find((track) => track.state === "failed");
  const error = broken?.error ?? null;
  const step = ((): StepName => {
    const head = LOCAL_STEPS.find((local) => !tracks.every((t) => hasPassed(t.state, local)));
    return head ?? "place";
  })();
  const message = `${String(count)} track(s) failed: ${error?.message ?? "no reason recorded"}`;
  const result: StepResult = {
    status: "failed",
    message,
    ...(error === null ? {} : { error }),
  };
  await upsertStepRow(db, importId, step, { status: "failed", message });
  await db
    .update(imports)
    .set({
      step,
      status: "failed",
      error,
      finishedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(imports.id, importId));
  return { step, result };
}

/**
 * Hand the import to `verify`: the album-wide tail of `tag` has run and every file is filed.
 *
 * `place` is closed here rather than re-run. Its work is per track and every track has been
 * through it; running the album-wide `place` again would walk the whole tracklist to discover
 * that each file is already where it belongs, and overwrite a sentence that said something
 * with one that says `0 file(s) placed`.
 */
export async function handOverToVerify(db: Database, importId: string): Promise<void> {
  const tracks = await mappedTracksOf(db, importId);
  const placed = tracks.filter((track) => track.state === "placed" || track.state === "done");
  await upsertStepRow(db, importId, "place", {
    status: placed.length === 0 ? "skipped" : "done",
    message:
      placed.length === 0
        ? "Nothing to place."
        : `${String(placed.length)} file(s) placed, one at a time as they arrived`,
  });
  await db
    .update(imports)
    .set({ step: "verify", status: "running", error: null, updatedAt: new Date() })
    .where(eq(imports.id, importId));
}
