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
import { MMError } from "@mm/contracts";
import { decisions, imports, jobSteps, type ImportTrack } from "#/server/db/schema/index.ts";
import { newId } from "#/server/ids.ts";
import { learnPreferences } from "#/server/services/matching.preferences.ts";
import { listInbox, openInboxItem, resolveInboxItem } from "#/server/services/inbox.ts";
import {
  cellsFromUncoveredPayload,
  materialiseSourcelessTracks,
} from "#/server/services/sourceless.ts";
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
 * Read the shape of the match off `job_steps`, the same row and for the same reason.
 *
 * Separate from `matchVerdict` because it must survive what that one refuses: a supplied
 * mapping records no `safe`, and the answer for it here is "somebody answered", not "I cannot
 * tell". Reading the row rather than recomputing is what makes the gate hold on a retry, a
 * resume and an Inbox answer alike.
 */
async function matchShape(ctx: StepContext): Promise<MatchShape | null> {
  const [row] = await ctx.db
    .select({ result: jobSteps.result })
    .from(jobSteps)
    .where(and(eq(jobSteps.importId, ctx.job.id), eq(jobSteps.step, "match")))
    .limit(1);
  const data = row?.result;
  if (data === null || data === undefined) return null;

  const count = (key: string): number | null =>
    typeof data[key] === "number" ? (data[key] as number) : null;
  const mapped = count("mapped");
  const extras = count("extras");
  const uncovered = count("uncovered");
  const kind = data["kind"];

  return {
    kind: kind === "album" || kind === "single" ? kind : null,
    answered: data["supplied"] === true || data["pinned"] === true,
    untagged: data["untagged"] === true,
    videos: mapped === null || extras === null ? null : mapped + extras,
    bound: mapped,
    tracks: mapped === null || uncovered === null ? null : mapped + uncovered,
    artistCarried: typeof data["artistCarried"] === "boolean" ? data["artistCarried"] : null,
  };
}

/**
 * What `match` made of the source, as far as the exactness gate is concerned.
 *
 * Four numbers and a flag, all of them written by the step that knew them. `null` on any of
 * them means the row does not say — an older import, a step that never ran — and that is
 * treated as "I cannot tell", which is not "it is fine".
 */
export interface MatchShape {
  readonly kind: "album" | "single" | null;
  /** Somebody named the release or the whole mapping; the engine did not choose. */
  readonly answered: boolean;
  /**
   * There is no MusicBrainz release behind this import at all.
   *
   * `match` wrote `releaseMbid: null` — "import without MusicBrainz" — because the CLI asked
   * for it or because the untagged fallback took a folder MusicBrainz cannot identify.
   */
  readonly untagged: boolean;
  /** Videos in the source: the ones bound plus the ones left over. */
  readonly videos: number | null;
  /** Videos bound to a track of the chosen release. */
  readonly bound: number | null;
  /** Tracks on the chosen release: the ones covered plus the ones left empty. */
  readonly tracks: number | null;
  readonly artistCarried: boolean | null;
}

/**
 * **The engine may confirm on its own only on an exact match.**
 *
 * Four conditions, and a sentence naming the first one that fails:
 *
 *  1. every video of the source is bound to a track;
 *  2. no track of the release is left without a video;
 *  3. no video is left over — which is (1) said from the other side, and kept separate
 *     because the sentence a person needs to read is different;
 *  4. the artist the source names is carried by the release that was chosen.
 *
 * It is the generalisation of the artist refusal that `match` already applies, and it exists
 * for the five albums of the sixth owner review that **have no release of the right size in
 * MusicBrainz at all** — *Smoke + Mirrors* (21 videos), *Random Access Memories (Drumless)*
 * (13), *The Family Jewels* (13), *Night Candy* (4), *Ceremonials* (15). One was chosen anyway
 * and imported without a question. A parked import beats a wrong album that looks finished.
 *
 * Three exemptions. Two of them are a person, and the third is an import with no release for
 * the four conditions to be about:
 *
 *  - **`answered`** — a pinned release (`--release`) or a supplied mapping (the wizard,
 *    `confirm-mapping`, MCP). Somebody named the answer after seeing the counts; this rule
 *    exists to ask somebody, and there is nobody left to ask;
 *  - **a single** — one video against a recording. "Uncovered tracks" is meaningless for it:
 *    the release it is filed under is context, not a tracklist to cover, which is why the
 *    wizard sends `trackTotal: 0` for one. The artist condition still applies;
 *  - **`untagged`** — "import without MusicBrainz", which is what the untagged fallback makes
 *    of a folder MusicBrainz cannot identify. See the note on the guard itself.
 */
export function exactnessRefusal(shape: MatchShape | null): string | null {
  if (shape === null) return "the match step recorded nothing to judge";
  if (shape.answered) return null;

  /*
   * **An import with no release is not an inexact match; it is a different question.**
   *
   * All four conditions below compare the source against *the release that was chosen*, and an
   * untagged import chose none: `match` wrote `releaseMbid: null` and built the document from
   * the source's own tags. A folder import is the case that makes this matter — the files are
   * the tracklist, they are all bound, nothing is left over on either side, and there is no
   * record for them to fail to cover. Blocking it would refuse the one shape of import where
   * there is genuinely nothing to ask a person about.
   *
   * It is not a waiver of the rule. The gate exists to stop the engine filing an album under a
   * release **nobody vetted**, and an untagged import files it under no release at all: the
   * album carries the `untagged` flag in the library precisely so it can be found and finished
   * later. A folder MusicBrainz *can* identify takes the ordinary path and is judged by the
   * four conditions like anything else — pointing at a folder is consent to import those
   * files, not consent to a release the matcher guessed for them.
   */
  if (shape.untagged) return null;

  if (shape.artistCarried === false) {
    return "no candidate is credited to the artist the source names";
  }

  if (shape.kind === "single") return null;

  const { videos, bound, tracks } = shape;
  if (videos === null || bound === null || tracks === null) {
    return "the match step recorded no tracklist fit to judge";
  }
  if (bound < videos) {
    const left = videos - bound;
    return `${String(left)} of your ${String(videos)} video(s) are on no track of this release`;
  }
  if (tracks > bound) {
    const empty = tracks - bound;
    return `${String(empty)} track(s) of this release have no video`;
  }
  return null;
}

/**
 * May this import be confirmed without anybody looking at it?
 *
 * Pure, and the whole of the exception `docs/04-pipeline-et-matching.md` grants. The three
 * conditions it always had — the source opted in, the match is `safe`, unambiguous and above
 * the bar — plus the exactness rule, which is **not** the watched source's own and is applied
 * to every unattended confirmation alike. The order is deliberate: the permission first, so a
 * source that never opted in is told that and not something about its tracklist.
 *
 * A `null` verdict is a `match` step that recorded nothing judgeable — a supplied mapping, a
 * pinned release, an older row — and it refuses, because "I cannot tell" is not "it is fine".
 */
export function autoAcceptDecision(input: {
  readonly allowed: boolean;
  readonly verdict: MatchVerdict | null;
  readonly threshold: number;
  /** `undefined` on the older callers, which are only asking about the three score rules. */
  readonly shape?: MatchShape | null;
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
  if (input.shape !== undefined) {
    const refusal = exactnessRefusal(input.shape);
    if (refusal !== null) return { accept: false, why: refusal };
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
  const shape = await matchShape(ctx);
  const threshold =
    ctx.job.options.sourceAutoAcceptThreshold ?? ctx.settings.watchedSourcesAutoAcceptThreshold;
  const allowed = ctx.job.options.sourceAutoAccept === true;
  const { accept, why } = autoAcceptDecision({ allowed, verdict, threshold, shape });

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

/**
 * Turn this import's `uncovered_tracks` notice into `sourceless` rows, and say how many.
 *
 * Reads the item whatever its status. An owner who answered the notice with "import anyway"
 * before the worker reached `confirm` said *carry on without those tracks*, not *pretend the
 * record has nineteen*: the gap is the same gap, and the row is what finally makes it
 * actionable. The notice is left exactly as it was — this function only reads.
 *
 * Every failure is swallowed into a journal line on purpose. See the call site: a release has
 * just been confirmed and eighteen tracks are ready to download, and none of that may be
 * undone because a payload would not parse.
 */
async function materialiseGaps(ctx: StepContext, decidedBy: string): Promise<number> {
  try {
    const item = (await listInbox({ importId: ctx.job.id }, ctx.db))
      .filter((row) => row.type === "uncovered_tracks")
      .at(-1);
    if (item === undefined) return 0;

    const cells = cellsFromUncoveredPayload(item.payload);
    if (cells.length === 0) return 0;

    const { created } = await materialiseSourcelessTracks({
      importId: ctx.job.id,
      cells,
      by: decidedBy,
      db: ctx.db,
    });
    if (created.length === 0) return 0;

    await ctx.say(
      "tracks.sourceless",
      `${String(created.length)} track(s) of this release have no video and are waiting for a file or an address`,
      {
        level: "info",
        data: {
          created: created.length,
          tracks: created.map((row) => ({
            id: row.id,
            mediumPosition: row.mediumPosition,
            trackPosition: row.trackPosition,
            title: row.trackTitle,
          })),
        },
      },
    );
    return created.length;
  } catch (error) {
    await ctx.say(
      "tracks.sourceless",
      `The uncovered tracks of this release could not be listed: ${MMError.from(error).message}`,
      { level: "warn" },
    );
    return 0;
  }
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

  /**
   * Somebody has said yes to this import, by name.
   *
   * `autoConfirm` on its own is not that — fixtures mode sets it, and a `--yes` inherited from
   * a template would too — which is why the signature is what counts. `assertSigned` refuses
   * an unsigned one at both of the two functions that can set it, so a value here names a real
   * caller: `console`, `api`, `mcp`, `cli --yes`.
   */
  const signedBy = ctx.job.options.confirmedBy?.trim() ?? "";
  const signed = ctx.job.options.autoConfirm === true && signedBy !== "";

  /*
   * An import nobody asked for by hand is decided by the source that opened it, and by
   * nothing else — not `--yes`, not fixtures mode. See `confirmForWatchedSource`.
   *
   * **Unless a person answered it.** The exception is about imports *nobody looked at*; once
   * somebody presses Confirm on the job page, or answers the Inbox item this branch raised,
   * the import has been looked at and the source's policy has nothing left to decide. Without
   * this, the Console's Confirm button opened the gate and the step walked straight past it
   * into `blocked` again — the button worked and the job never moved.
   */
  const watchedSourceId = ctx.job.options.watchedSourceId;
  if (!signed && typeof watchedSourceId === "string" && watchedSourceId !== "") {
    return await confirmForWatchedSource(ctx, mapped, watchedSourceId);
  }

  /*
   * **The exactness rule is not enforced here, and that is deliberate.**
   *
   * The two doors the engine confirms through *alone* are `confirm-best` — "le seul chemin qui
   * valide une release sans que personne ne lise la fiche" (`docs/04`), and the one the owner's
   * bulk session of 375 playlists went through — and a watched source's auto-accept. Both are
   * gated by `exactnessRefusal`, in `services/imports.bulk.ts` and in `autoAcceptDecision`
   * above.
   *
   * What reaches this line is a person: `--yes` is somebody typing a flag for one URL, a
   * supplied mapping is somebody having read the counts, and fixtures mode exists to *stand in
   * for* the person the offline run and the demo do not have. Refusing here would park the
   * offline run on questions the real installation answers — the mirror image of the rule
   * `confirmForWatchedSource` states about fixtures mode, one direction along.
   */
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
   * `cli --yes`. `createImport` and `setImportOptions` — the only two functions that can set
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
   * Give the tracks nothing covers a row of their own, now that the release is a decision.
   *
   * **Here, and not in `match`.** `match` *proposes* a release; until this line runs, the
   * tracklist it proposed might still be replaced by another — a re-match, a different
   * candidate chosen from the review card — and rows created off a proposal would have to be
   * deleted again when it changed. Confirmation is the first instant the tracklist is settled,
   * which makes it the first instant a gap in it is a fact rather than a guess. It is also
   * literally what the owner asked for: the rows appear when you say yes.
   *
   * The grid comes from the `uncovered_tracks` notice `match` already wrote, which is the same
   * grid the owner was shown before pressing Confirm — so what gets created is what the card
   * listed, and this costs no MusicBrainz lookup at a point where somebody is waiting.
   *
   * Failure here is **not** a failed confirmation. The release has been chosen, the decision
   * row is written, and the tracks that do have videos are ready to download; refusing all of
   * that because a notice could not be read would trade a complete album for an incomplete
   * one. The gap stays a notice, which is what it was before this existed.
   */
  const sourceless = await materialiseGaps(ctx, decidedBy);

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
    message:
      `Confirmed automatically (${decidedBy}): ${String(mapped.length)} track(s).` +
      (sourceless === 0
        ? ""
        : ` ${String(sourceless)} track(s) of the release have no video and are waiting for a source.`),
    data: { decidedBy, tracks: mapped.length, sourceless, learnedFrom: learned?.from ?? 0 },
  };
}
