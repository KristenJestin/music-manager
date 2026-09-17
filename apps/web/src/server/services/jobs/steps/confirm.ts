/**
 * Step 3 — `confirm` (you).
 *
 * The one deliberately **blocking** step of the pipeline. `docs/04-pipeline-et-matching.md`
 * calls it a wizard: release, 1:1 mapping, options. Decision 002 says the algorithm never
 * chooses for you, and a "safe" score of 0.95 marks the first candidate without skipping this
 * gate.
 *
 * Two things unblock it for an import somebody asked for, and only two: `--yes` on the CLI,
 * and fixtures mode — the offline end-to-end run and the demo have nobody to ask. Both are
 * recorded as a `decisions` row with `decidedBy` saying which, so an unattended import is
 * never mistaken for a confirmed one.
 *
 * An import a **watched source** opened takes a third path entirely, and neither of those two
 * applies to it: see `confirmForWatchedSource` below. That is the one exception `docs/04`
 * grants, and it is per source, off by default, and spent only on an unambiguous match.
 */
import { and, eq } from "drizzle-orm";
import { decisions, imports, jobSteps, type ImportTrack } from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { learnPreferences } from "#/server/services/matching.preferences.ts";
import { listInbox, openInboxItem, resolveInboxItem } from "#/server/services/inbox.ts";
import type { StepResult } from "../machine.ts";
import type { StepContext } from "../context.ts";

/* ------------------------------------------------------------------ */
/* the watched-source gate                                             */
/* ------------------------------------------------------------------ */

/** What `match` concluded, as far as this gate is concerned. */
export interface MatchVerdict {
  /** The chosen candidate cleared `safeThreshold`. */
  readonly safe: boolean;
  /** Two candidates were close enough that preferring one would be a guess. */
  readonly ambiguous: boolean;
  /** Score of the chosen candidate, or `null` when the step did not record one. */
  readonly score: number | null;
}

/**
 * Read `match`'s own result off `job_steps`.
 *
 * Off the row rather than out of the context: `match` and `confirm` run inside one
 * `transition()`, but they also run *separately* — a retry, a resume, an Inbox answer that
 * re-queues the job — and a gate that only worked when the two happened together would open
 * on the common path and refuse on the rare one. `null` means "the step recorded nothing I can
 * judge", which is treated as "do not auto-accept".
 */
async function matchVerdict(ctx: StepContext): Promise<MatchVerdict | null> {
  const [row] = await ctx.db
    .select({ result: jobSteps.result })
    .from(jobSteps)
    .where(and(eq(jobSteps.importId, ctx.job.id), eq(jobSteps.step, "match")))
    .limit(1);
  const data = row?.result;
  if (data === null || data === undefined) return null;
  if (typeof data["safe"] !== "boolean") return null;

  const candidates = data["candidates"];
  const first = Array.isArray(candidates)
    ? (candidates[0] as { score?: unknown } | undefined)
    : undefined;
  return {
    safe: data["safe"],
    ambiguous: data["ambiguous"] === true,
    score: typeof first?.score === "number" ? first.score : null,
  };
}

/**
 * May this import be confirmed without anybody looking at it?
 *
 * Pure, and the whole of the exception `docs/04-pipeline-et-matching.md` grants: three
 * conditions that must all hold, and a sentence saying which one did not. A `null` verdict is
 * a `match` step that recorded nothing judgeable — a supplied mapping, a pinned release, an
 * older row — and it refuses, because "I cannot tell" is not "it is fine".
 */
export function autoAcceptDecision(input: {
  readonly allowed: boolean;
  readonly verdict: MatchVerdict | null;
  readonly threshold: number;
}): { readonly accept: boolean; readonly why: string } {
  const { allowed, verdict, threshold } = input;
  if (!allowed) return { accept: false, why: "auto-accept is off for this source" };
  if (verdict === null) {
    return { accept: false, why: "the match step recorded no confidence to judge" };
  }
  if (verdict.ambiguous) {
    return { accept: false, why: "two candidates scored too close to call" };
  }
  if (!verdict.safe) {
    return { accept: false, why: "the best candidate is below the safe threshold" };
  }
  if (verdict.score !== null && verdict.score < threshold) {
    return {
      accept: false,
      why: `the best candidate scored ${String(verdict.score)}, under ${String(threshold)}`,
    };
  }
  return { accept: true, why: "" };
}

/**
 * `confirm` for an import a **watched source** opened.
 *
 * Two rules, and they are the reason this branch exists at all rather than reusing the
 * `autoConfirm` path:
 *
 *  1. **Fixtures mode does not open this gate.** Everywhere else, fixtures mode confirming for
 *     you is right — there is a person running an offline demo and nobody to ask. Here there
 *     is no person at all: an unattended import must be decided by the source's own policy in
 *     every mode, or the offline run would prove something the real installation does not do.
 *  2. **`autoAccept` is a permission, not an instruction.** It is spent only on a match that
 *     is `safe`, not `ambiguous`, and above the threshold — the source's own when it set one,
 *     `watchedSourcesAutoAcceptThreshold` otherwise. Anything else parks the import in
 *     `awaiting_confirm` with an Inbox item pointing at it, which is the ordinary behaviour of
 *     `docs/04-pipeline-et-matching.md` and the thing this feature is an exception *to*.
 */
async function confirmForWatchedSource(
  ctx: StepContext,
  mapped: readonly ImportTrack[],
  sourceId: string,
): Promise<StepResult> {
  const verdict = await matchVerdict(ctx);
  const threshold =
    ctx.job.options.sourceAutoAcceptThreshold ?? ctx.settings.watchedSourcesAutoAcceptThreshold;
  const allowed = ctx.job.options.sourceAutoAccept === true;
  const { accept, why } = autoAcceptDecision({ allowed, verdict, threshold });

  if (accept) {
    await ctx.db.insert(decisions).values({
      id: newId("decision"),
      kind: "release",
      importId: ctx.job.id,
      subject: ctx.job.releaseMbid,
      choice: {
        releaseMbid: ctx.job.releaseMbid,
        tracks: mapped.length,
        watchedSourceId: sourceId,
        threshold,
        score: verdict?.score ?? null,
        mapping: mapped.map((track) => ({
          video: track.videoId,
          trackPosition: track.trackPosition,
          recordingMbid: track.recordingMbid,
        })),
      },
      // Never `user`, never `cli --yes`: the audit trail has to be able to answer "which of
      // my albums did nobody look at?" with one query.
      decidedBy: "watched-source",
    });
    await ctx.db.update(imports).set({ updatedAt: new Date() }).where(eq(imports.id, ctx.job.id));

    /*
     * **No preference learning here.** `learnPreferences` exists to read *your* taste out of
     * the releases you chose; feeding it a decision the machine took would let the matcher
     * teach itself its own habits, and after a few hundred unattended imports the country and
     * format preferences would describe the algorithm rather than the listener.
     */
    return {
      status: "done",
      message: `Accepted automatically from its watched source: ${String(mapped.length)} track(s).`,
      data: {
        decidedBy: "watched-source",
        watchedSourceId: sourceId,
        tracks: mapped.length,
        threshold,
        score: verdict?.score ?? null,
      },
    };
  }

  await openInboxItem(
    {
      type: "source_new_video",
      importId: ctx.job.id,
      title: `A watched source found “${ctx.job.title ?? ctx.job.url}”`,
      summary: `Waiting for you because ${why}.`,
      payload: {
        watchedSourceId: sourceId,
        url: ctx.job.url,
        releaseMbid: ctx.job.releaseMbid,
        tracks: mapped.length,
        autoAccept: allowed,
        threshold,
        safe: verdict?.safe ?? null,
        ambiguous: verdict?.ambiguous ?? null,
        score: verdict?.score ?? null,
        why,
      },
      preselected: { action: "confirm" },
    },
    ctx.db,
  );

  return {
    status: "blocked",
    blockedAs: "awaiting_confirm",
    message: `Waiting for confirmation of ${String(mapped.length)} track(s): ${why}.`,
    data: {
      watchedSourceId: sourceId,
      autoAccept: allowed,
      threshold,
      safe: verdict?.safe ?? null,
      ambiguous: verdict?.ambiguous ?? null,
      score: verdict?.score ?? null,
      why,
    },
  };
}

/** Answer the item that was asking for this yes — either of the two — if it is still open. */
async function closeConfirmItem(ctx: StepContext, decidedBy: string): Promise<void> {
  const { WAITING_FOR_YES } = await import("#/server/services/confirm.ts");
  const item = (await listInbox({ importId: ctx.job.id, status: "open" }, ctx.db)).find((row) =>
    WAITING_FOR_YES.includes(row.type),
  );
  if (item === undefined) return;
  await resolveInboxItem(
    item.id,
    { resolution: { accepted: true, confirmedBy: decidedBy }, decidedBy },
    ctx.db,
  );
}

export async function confirmStep(ctx: StepContext): Promise<StepResult> {
  const mapped = await ctx.mappedTracks();

  /*
   * An import nobody asked for by hand is decided by the source that opened it, and by
   * nothing else — not `--yes`, not fixtures mode. See `confirmForWatchedSource`.
   */
  const watchedSourceId = ctx.job.options.watchedSourceId;
  if (typeof watchedSourceId === "string" && watchedSourceId !== "") {
    return await confirmForWatchedSource(ctx, mapped, watchedSourceId);
  }

  const automatic = ctx.job.options.autoConfirm === true || ctx.fixtures;

  if (!automatic) {
    const tracks = mapped.map((track) => ({
      position: track.position,
      title: track.sourceTitle,
      trackPosition: track.trackPosition,
      trackTitle: track.trackTitle,
      confidence: track.confidence,
    }));

    /*
     * **Say so in the Inbox**, not only in `imports.status`.
     *
     * This branch used to block silently. The job page said "Needs confirm" and offered Retry
     * and Cancel; the review queue — which is where the owner actually works, and which reads
     * `inbox_items` — knew nothing about it. So every import that reached this step outside
     * the wizard was unreachable: a batch import, a `mm import` without `--yes`, a job
     * re-matched after an Inbox answer. The watched-source branch above has raised an item for
     * exactly this state since P09; the ordinary branch simply never did.
     *
     * Idempotent per import, like every other item: re-running `confirm` refreshes this one
     * rather than piling up a second.
     */
    await openInboxItem(
      {
        type: "awaiting_confirm",
        importId: ctx.job.id,
        title: `Confirm “${ctx.job.title ?? ctx.job.url}”`,
        summary:
          `${String(mapped.length)} track(s) are mapped and waiting for your yes. ` +
          "Nothing is downloaded until you give it.",
        payload: { releaseMbid: ctx.job.releaseMbid, url: ctx.job.url, tracks },
        preselected: { action: "confirm" },
      },
      ctx.db,
    );

    return {
      status: "blocked",
      blockedAs: "awaiting_confirm",
      message: `Waiting for confirmation of ${String(mapped.length)} track(s).`,
      data: { releaseMbid: ctx.job.releaseMbid, tracks },
    };
  }

  /*
   * Provenance is claimed by the caller that opened the gate, never guessed from the fact
   * that it is open: MCP is `mcp`, `/api/v1` is `api`, the wizard is `console`, the CLI is
   * `cli --yes`. `createFromUrl` and `setImportOptions` — the only two functions that can set
   * `autoConfirm` — now refuse an unsigned one, so every row written from today carries the
   * caller's own name.
   *
   * The fallback survives for **rows written before that guard**, whose options genuinely
   * hold no `confirmedBy`. It says `cli --yes (unsigned)` rather than `cli --yes`, because
   * the one thing the old default did wrong was to look like a claim when it was a guess.
   */
  const decidedBy =
    ctx.job.options.autoConfirm === true
      ? (ctx.job.options.confirmedBy ?? "cli --yes (unsigned)")
      : "fixtures";
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

  /*
   * The question has been answered, so it stops being asked.
   *
   * Whoever opened the gate — the wizard, `confirm-mapping`, `confirm-best`, MCP, `--yes` —
   * answers the `awaiting_confirm` item this step raised, whether or not they knew it existed.
   * Closing it here rather than in each of those callers is the only way a caller added later
   * cannot forget. The resolution carries **no `action`**: the act is already done by the time
   * this line runs, and an `action: "confirm"` would send `applyResolution` round to open a
   * gate that is open.
   */
  await closeConfirmItem(ctx, decidedBy);

  // A confirmed release is the one piece of evidence about your taste that is not a guess, so
  // it is what the country/format preferences are learned from (P05). It reads the decision
  // log, needs several agreeing decisions before it moves anything, and writes only to
  // `settings`, where `mm settings list` shows it — never silently (`docs/04` § Ce que l'algo
  // ne fait jamais). It cannot affect this job: the release is already chosen.
  const learned = await learnPreferences(ctx.db);
  for (const change of learned?.changes ?? []) {
    await ctx.say("preferences.learned", change, { level: "info" });
  }

  return {
    status: "done",
    message: `Confirmed automatically (${decidedBy}): ${String(mapped.length)} track(s).`,
    data: { decidedBy, tracks: mapped.length, learnedFrom: learned?.from ?? 0 },
  };
}
