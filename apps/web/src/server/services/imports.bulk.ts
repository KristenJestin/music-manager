/**
 * The two service functions the bulk-import ergonomics stand on.
 *
 * Both exist because of one session: three hundred and seventy-five YouTube playlists driven
 * through `/api/v1` and the MCP tools by hand. Two things cost most of that wall-clock and
 * most of the mistakes, and neither is a missing feature of the pipeline — they are missing
 * *doors* onto machinery that was already there.
 *
 *  - **`createImportsBatch`.** One HTTP call per URL is a thousand round trips and a thousand
 *    pg-boss producers. One call takes the list, and a URL the server refuses loses only
 *    itself: the other three hundred and seventy-four are created regardless, and the refusal
 *    travels back next to the URL that caused it rather than as a 400 for the whole batch.
 *  - **`confirmBest`.** `confirm-mapping` asks the caller for the video → recording mapping,
 *    which the caller has to rebuild from `get_candidates` by hand — and the owner wrote three
 *    bugs doing it. The server already knows the answer: `ReleaseCandidate.fitLines` *is* the
 *    assignment the engine computed in order to score that candidate in the first place, and it
 *    already carries `recordingMbid`, `trackMbid`, `trackPosition` and `mediumPosition`. This
 *    function picks a candidate and reads those lines; it computes no mapping of its own, so it
 *    cannot disagree with the one the score was based on.
 *
 * `confirmBest` does **not** touch the scorer. `preferType` is a tie-break applied after the
 * ranking, on the candidate's release-group `primary-type`, and it moves nothing unless two
 * candidates map exactly the same number of tracks.
 *
 * ## Why a single goes through the same door
 *
 * `confirm-best` used to refuse a one-video import by name, and the refusal was right about the
 * *bar*: a single is ranked against **recordings**, not releases (`rankFor`, `matchSingle`),
 * there is no tracklist, and coverage would be 1 whatever was chosen. It was wrong about the
 * conclusion — ten imports sat waiting with no automatic path at all, because no tool could
 * decide between two candidate recordings.
 *
 * It is the **same** endpoint, tool and command rather than a sibling, for one reason: the
 * caller loops over the ids `create_imports` handed back and does not know which of them the
 * `resolve` step will turn out to have made a single. A second name would put a `kind` branch
 * in every caller — exactly the client-side bookkeeping this function exists to delete — and
 * two names for "confirm the engine's own best answer, automatically, signed, or refuse" is
 * the half-synonym nobody can remember the difference between. What changes with `kind` is the
 * *criterion*, and the criterion is named in the answer (`kind`, `minMargin` or `minCoverage`)
 * and in the refusal, so nothing is silently decided on a number that does not apply.
 *
 * The bar for a recording is `judgeRecording` below: margin over the runner-up, duration
 * agreement, title agreement, artist agreement — four conditions, all of them things that mean
 * something for *one song*, all of them read from thresholds the engine already uses.
 */
import { MMError, type MMErrorBody } from "@mm/contracts";
import {
  withDefaults,
  type MatchingThresholds,
  type MatchVideo,
  type RecordingCandidate,
  type ReleaseCandidate,
} from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import type { Import, ImportTrack } from "#/server/db/schema/index.ts";
import { createImport, getImport } from "#/server/services/imports.ts";
import { setImportOptions } from "#/server/services/console.queries.ts";
import { listInbox, resolveInboxItem } from "#/server/services/inbox.ts";
import { rankFor, videosOf } from "#/server/services/matching.queries.ts";
import type { AlbumMatch } from "#/server/services/matching.service.ts";
import { configFromSettings } from "#/server/services/matching.service.ts";
import { runStep } from "#/server/services/jobs/index.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import { enqueue, enqueueMany } from "#/server/services/queue.ts";
import type { SuppliedMapping } from "#/server/services/jobs/steps/match.ts";
import { exactnessRefusal } from "#/server/services/jobs/steps/confirm.ts";

/* ------------------------------------------------------------------ */
/* batch creation                                                      */
/* ------------------------------------------------------------------ */

/**
 * How many URLs one batch may carry.
 *
 * A cap rather than no cap, because the request does one insert per URL and a client that
 * pastes its whole library into one body deserves a 400 naming the limit instead of a timeout.
 * A hundred is four calls for the owner's 375, which is three orders of magnitude better than
 * a thousand and still finishes inside a proxy's patience.
 */
export const MAX_BATCH_URLS = 100;

/** The options a batch applies to every URL in it. The same set the single route takes. */
export interface BatchOptions {
  readonly fingerprint?: boolean;
  readonly lyrics?: boolean;
  readonly replaygain?: boolean;
  readonly force?: boolean;
  readonly autoConfirm?: boolean;
  /** Required by `assertSigned` when `autoConfirm` is true: the caller names itself. */
  readonly confirmedBy?: string;
  readonly priority?: number;
}

/** One URL's outcome, in the position the caller sent it. */
export interface BatchLine {
  readonly index: number;
  readonly url: string;
  readonly ok: boolean;
  readonly id: string | null;
  readonly status: string | null;
  readonly step: string | null;
  /** Earlier imports of the same URL. Reported, never a refusal — see `createImport`. */
  readonly duplicates: readonly string[];
  readonly error: MMErrorBody | null;
}

export interface BatchResult {
  readonly requested: number;
  readonly created: number;
  readonly failed: number;
  /** The created ids, in request order — the list to hand to `confirm_best` afterwards. */
  readonly ids: readonly string[];
  readonly results: readonly BatchLine[];
}

export interface BatchInput {
  readonly urls: readonly string[];
  readonly options?: BatchOptions;
  readonly db?: Database;
  /** What the journal records as the reason for the enqueue: `api`, `mcp`, `cli`. */
  readonly source?: string;
}

/**
 * Create one import per URL, and report each one's fate next to its URL.
 *
 * **The batch does not resolve in-process, and that is the one way it differs from
 * `POST /imports`.** The single route runs `resolve` before answering because somebody is
 * watching and wants to know what they just pasted; a hundred extractions in one request would
 * be several minutes of a held connection for the same courtesy. The rows come back `pending`
 * at step `resolve`, queued, and the worker resolves them — which is where that work belongs
 * when there are a hundred of them.
 *
 * A URL the server can refuse *before* creating anything (a scheme it cannot import, a
 * `fixture://` outside fixtures mode) becomes a line with an `error` and no id. Everything else
 * is a created import, exactly as on the single route: a source the toolbox cannot read is an
 * import in `failed`, not a missing one, because that failure is worth keeping.
 */
export async function createImportsBatch(input: BatchInput): Promise<BatchResult> {
  const db = input.db ?? defaultDb();
  const urls = input.urls.map((url) => url.trim());

  if (urls.length === 0) {
    throw new MMError("INVALID_INPUT", "A batch needs at least one URL.", {
      hint: "Send a non-empty `urls` array.",
      status: 400,
    });
  }
  if (urls.length > MAX_BATCH_URLS) {
    throw new MMError(
      "INVALID_INPUT",
      `A batch carries at most ${String(MAX_BATCH_URLS)} URLs; this one has ${String(urls.length)}.`,
      {
        hint: `Split the list into chunks of ${String(MAX_BATCH_URLS)}.`,
        details: { limit: MAX_BATCH_URLS, sent: urls.length },
        status: 400,
      },
    );
  }

  const options = input.options ?? {};
  const results: BatchLine[] = [];
  const created: string[] = [];

  for (const [index, url] of urls.entries()) {
    try {
      const outcome = await createImport(url, {
        db,
        // The worker resolves; see the note above.
        resolveNow: false,
        ...(options.fingerprint === undefined ? {} : { fingerprint: options.fingerprint }),
        ...(options.lyrics === undefined ? {} : { lyrics: options.lyrics }),
        ...(options.replaygain === undefined ? {} : { replaygain: options.replaygain }),
        ...(options.force === undefined ? {} : { force: options.force }),
        ...(options.autoConfirm === undefined ? {} : { autoConfirm: options.autoConfirm }),
        ...(options.confirmedBy === undefined ? {} : { confirmedBy: options.confirmedBy }),
        ...(options.priority === undefined ? {} : { priority: options.priority }),
      });
      created.push(outcome.job.id);
      results.push({
        index,
        url,
        ok: true,
        id: outcome.job.id,
        status: outcome.job.status,
        step: outcome.job.step,
        duplicates: outcome.duplicates.map((row) => row.id),
        error: null,
      });
    } catch (error) {
      /*
       * One bad URL must not lose the other three hundred and seventy-four.
       *
       * The failure is shaped like every other failure in this app — `MMError.from` gives a
       * `code` a client can branch on — and it is attached to the URL that produced it, so a
       * caller never has to diff the request against the response to find out which one broke.
       */
      results.push({
        index,
        url,
        ok: false,
        id: null,
        status: null,
        step: null,
        duplicates: [],
        error: MMError.from(error).toBody(),
      });
    }
  }

  // One pg-boss producer for the whole batch. `enqueue` opens and closes one per call, which
  // on a hundred imports is a hundred connections for a hundred sends.
  await enqueueMany(created, input.source ?? "api batch");

  return {
    requested: urls.length,
    created: created.length,
    failed: urls.length - created.length,
    ids: created,
    results,
  };
}

/* ------------------------------------------------------------------ */
/* confirm-best                                                        */
/* ------------------------------------------------------------------ */

/** The default coverage bar: four videos in five have to land on a track of the release. */
export const DEFAULT_MIN_COVERAGE = 0.8;

export type PreferType = "album" | "any";

export interface ConfirmBestInput {
  readonly importId: string;
  /** The album bar. Ignored on a single, which has no tracklist to cover. */
  readonly minCoverage?: number;
  /** The single bar. Ignored on an album, which is decided on coverage. */
  readonly minMargin?: number;
  readonly preferType?: PreferType;
  /** Who is confirming. Written to `decisions.decidedBy`; `assertSigned` requires it. */
  readonly confirmedBy: string;
  readonly db?: Database;
  readonly settings?: Settings;
  readonly source?: string;
}

/** The release that was chosen, and on what evidence. */
export interface ChosenRelease {
  readonly kind: "release";
  /** The release MBID. */
  readonly mbid: string;
  readonly title: string;
  readonly artist: string;
  readonly score: number;
  readonly year: number | null;
  /** The release group's `primary-type` — `Album`, `EP`, `Single`… `null` when unknown. */
  readonly primaryType: string | null;
  /** Videos this candidate binds to a track of its tracklist. */
  readonly mapped: number;
  /** Videos in the import, mapped or not — the denominator of `coverage`. */
  readonly videos: number;
  readonly coverage: number;
}

/** The recording that was chosen for a one-video import, and on what evidence. */
export interface ChosenRecording {
  readonly kind: "recording";
  /** The recording MBID — what the track row and the tags carry. */
  readonly mbid: string;
  readonly title: string;
  readonly artist: string;
  readonly score: number;
  /** The recording's length in seconds, as MusicBrainz has it. */
  readonly length: number | null;
  /** Score gap to the runner-up, or `null` when the engine found only one candidate. */
  readonly margin: number | null;
  /** `video − recording`, in seconds. `null` when either side has no duration. */
  readonly durationDelta: number | null;
  readonly titleAgreement: number;
  readonly artistAgreement: number;
  /** The release the track is filed under — `chooseBorrowRelease`'s answer. */
  readonly releaseMbid: string;
  readonly releaseTitle: string;
  readonly releaseType: string | null;
  readonly trackPosition: number;
}

export type ChosenCandidate = ChosenRelease | ChosenRecording;

export interface ConfirmBestResult {
  readonly importId: string;
  /** Which criterion decided this import: coverage for an album, the margin bar for a single. */
  readonly kind: "album" | "single";
  readonly chosen: ChosenCandidate;
  /** The album bar that applied, or `null` on a single. */
  readonly minCoverage: number | null;
  readonly preferType: PreferType | null;
  /** The single bar that applied, or `null` on an album. */
  readonly minMargin: number | null;
  readonly candidatesConsidered: number;
  /** What the `match` step really did with the mapping, as opposed to what was sent. */
  readonly mapped: number | null;
  readonly extras: number | null;
  readonly uncovered: number;
  readonly queued: boolean;
  readonly confirmedBy: string;
  readonly status: string;
  readonly step: string;
}

/** A candidate with the two numbers the choice is made on. */
export interface RankedCandidate {
  readonly candidate: ReleaseCandidate;
  readonly mapped: number;
  readonly coverage: number;
  readonly isAlbum: boolean;
}

/** `primary-type` is free text on the wire; this is the only place that interprets it. */
export function isAlbumType(type: string | null): boolean {
  return (type ?? "").trim().toLowerCase() === "album";
}

/* ------------------------------------------------------------------ */
/* the bar for a single                                                */
/* ------------------------------------------------------------------ */

/**
 * The four numbers a recording has to clear to be confirmed without a human.
 *
 * All four come from thresholds the matching engine already uses, so the bar is not a second
 * opinion invented here — it is the engine's own vocabulary, read back:
 *
 *  - **`minMargin`** is `thresholds.ambiguityMargin`, the gap under which `match` already
 *    refuses to decide and opens an `ambiguous_recording` Inbox item instead. Reusing it means
 *    `confirm-best` and the automatic pipeline cannot disagree about what "too close to call"
 *    means for the same pair of recordings;
 *  - **`durationToleranceSeconds`** is `docs/04`'s "à ± 2 s", the same window `mapping` binds a
 *    video to a track inside;
 *  - **`minAgreement`** is `thresholds.titleMatch` (0.87), applied to the title signal *and* to
 *    the artist signal. Both, because the way a single goes wrong is a cover or a karaoke
 *    version: same title, same length, different performer.
 */
export interface RecordingBar {
  readonly minMargin: number;
  readonly minAgreement: number;
  readonly durationToleranceSeconds: number;
}

/** The bar this installation's settings produce. Never a constant read straight from `config`. */
export function recordingBarOf(settings: Settings, minMargin?: number): RecordingBar {
  const thresholds: MatchingThresholds = withDefaults(configFromSettings(settings)).thresholds;
  return {
    minMargin: minMargin ?? thresholds.ambiguityMargin,
    minAgreement: thresholds.titleMatch,
    durationToleranceSeconds: thresholds.durationToleranceSeconds,
  };
}

/** What the bar said, and — when it said no — every reason it said no. */
export interface RecordingVerdict {
  readonly ok: boolean;
  readonly margin: number | null;
  readonly durationDelta: number | null;
  readonly titleAgreement: number;
  readonly artistAgreement: number;
  /** One sentence per failed condition, in the order they are checked. Empty when `ok`. */
  readonly failures: readonly string[];
}

const round3 = (value: number): number => Math.round(value * 1000) / 1000;

/**
 * Decide whether the engine's best recording is decisive enough to confirm unattended.
 *
 * Pure, and exported for the unit test: this is the whole of the single's criterion, and it is
 * the part somebody will one day be tempted to soften into "well, it was nearly right".
 *
 * **Absent evidence is not agreement.** A candidate with no length, or a video whose duration
 * the source never gave, fails the duration condition rather than skipping it — the brief is
 * "refuse rather than guess when the margin is thin", and a missing number is thinner than a
 * thin one. A missing runner-up is the one exception, and it is not evidence of anything: with
 * a single candidate there is no gap to measure, so `margin` is `null` and the other three
 * conditions carry the decision alone.
 */
export function judgeRecording(
  chosen: RecordingCandidate,
  runnerUp: RecordingCandidate | undefined,
  video: Pick<MatchVideo, "durationSeconds">,
  bar: RecordingBar,
): RecordingVerdict {
  const margin = runnerUp === undefined ? null : round3(chosen.score - runnerUp.score);
  const delta =
    video.durationSeconds == null || chosen.length === null
      ? null
      : round3(video.durationSeconds - chosen.length);
  const failures: string[] = [];

  if (chosen.borrow === null) {
    failures.push("it is on no release this import could be filed under");
  }
  if (margin !== null && margin < bar.minMargin) {
    failures.push(
      `it is only ${String(margin)} ahead of “${runnerUp?.title ?? "the runner-up"}” by ` +
        `${runnerUp?.artist ?? "?"}, under the ${String(bar.minMargin)} margin this call asked for`,
    );
  }
  if (delta === null) {
    failures.push("the video or the recording has no duration, so nothing corroborates the title");
  } else if (Math.abs(delta) > bar.durationToleranceSeconds) {
    failures.push(
      `the durations disagree by ${String(Math.abs(delta))} s, over the ` +
        `${String(bar.durationToleranceSeconds)} s tolerance`,
    );
  }
  if (chosen.signals.title < bar.minAgreement) {
    failures.push(
      `the title agreement is ${String(chosen.signals.title)}, under ${String(bar.minAgreement)}`,
    );
  }
  if (chosen.signals.artist < bar.minAgreement) {
    failures.push(
      `the artist agreement is ${String(chosen.signals.artist)}, under ` +
        `${String(bar.minAgreement)} — a cover scores exactly like this`,
    );
  }

  return {
    ok: failures.length === 0,
    margin,
    durationDelta: delta,
    titleAgreement: chosen.signals.title,
    artistAgreement: chosen.signals.artist,
    failures,
  };
}

/**
 * Order the candidates the way `confirm-best` chooses.
 *
 * Most mapped tracks first, because that is the question — "which of these releases imports the
 * most of what I pasted?". `preferType: "album"` then breaks a tie in favour of an Album over an
 * EP or a Single, which is the case the owner kept having to undo by hand: a single that happens
 * to contain the same recordings maps exactly as many tracks and files the result under the
 * wrong record. The last tie-break is the engine's own score, so two Albums that map the same
 * tracks are still separated by everything else it measured.
 *
 * Pure, and exported for the unit test: this is the part worth pinning down.
 */
export function orderCandidates(
  candidates: readonly RankedCandidate[],
  preferType: PreferType,
): RankedCandidate[] {
  return [...candidates].sort((a, b) => {
    if (a.mapped !== b.mapped) return b.mapped - a.mapped;
    if (preferType === "album" && a.isAlbum !== b.isAlbum) return a.isAlbum ? -1 : 1;
    return b.candidate.score - a.candidate.score;
  });
}

/**
 * Confirm the engine's own best answer, or refuse and change nothing.
 *
 * Two criteria behind one door, chosen by what the import turned out to be — see the module
 * header for why it is one door. An album is decided on **coverage** (`confirmBestRelease`); a
 * single on the **margin bar** of `judgeRecording` (`confirmBestRecording`). Both refuse with an
 * `AWAITING_CONFIRM` 409 that names the candidate and the number it missed, and both leave the
 * import exactly as they found it when they refuse. That is the point of a bar: a batch of three
 * hundred may confirm two hundred and ninety of itself, and the ten it would not decide have to
 * still be there afterwards.
 */
export async function confirmBest(input: ConfirmBestInput): Promise<ConfirmBestResult> {
  const db = input.db ?? defaultDb();
  const confirmedBy = input.confirmedBy.trim();

  if (confirmedBy === "") {
    throw new MMError("INVALID_INPUT", "`confirmedBy` names whoever is confirming.", {
      hint: 'An automatic confirmation still signs the decision: "api", "mcp", "cli".',
      status: 400,
    });
  }

  const job = await getImport(input.importId, db);
  if (job === null) {
    throw new MMError("NOT_FOUND", `No import with id ${input.importId}.`, {
      hint: "List them with `GET /api/v1/imports`.",
      status: 404,
    });
  }

  const { rows, videos } = await videosOf(job.id, db);
  if (rows.length === 0) {
    throw new MMError("INVALID_INPUT", "This import has no videos yet, so nothing can be mapped.", {
      hint: "The `resolve` step has produced no listing. Read `GET /api/v1/imports/{id}`.",
      status: 400,
    });
  }

  const settings = input.settings ?? (await loadSettings(db));
  const result = await rankFor({ job, settings, db });
  const context: ConfirmContext = { job, rows, videos, settings, confirmedBy, db, input };

  return result.kind === "single"
    ? await confirmBestRecording(context, result.ranking)
    : await confirmBestRelease(context, result);
}

/** Everything both branches need, gathered once by `confirmBest`. */
interface ConfirmContext {
  readonly job: Import;
  readonly rows: readonly ImportTrack[];
  readonly videos: readonly MatchVideo[];
  readonly settings: Settings;
  readonly confirmedBy: string;
  readonly db: Database;
  readonly input: ConfirmBestInput;
}

/**
 * The album branch: pick the release that maps the most tracks, and confirm it.
 *
 * The mapping is `fitLines`, filtered to the bound lines and renamed into `SuppliedMapping`'s
 * vocabulary. No arithmetic, no matching, no second opinion: the engine already decided which
 * video is which track when it scored this candidate, and re-deriving that here is precisely the
 * work this function exists to stop a client doing.
 */
async function confirmBestRelease(
  context: ConfirmContext,
  result: AlbumMatch,
): Promise<ConfirmBestResult> {
  const { job, rows, input } = context;
  const candidates = result.ranking.candidates;
  const minCoverage = input.minCoverage ?? DEFAULT_MIN_COVERAGE;
  const preferType = input.preferType ?? "album";

  /*
   * The same artist gate the `match` step applies, and for the same reason.
   *
   * `confirm-best` is the one path that commits a release without a person reading the card,
   * so the rule that "nothing here is by the artist the source names" must stop it too. The
   * coverage bar would catch the owner's *Bewitched* by accident — Laura Fygi's twelve tracks
   * map seven of fourteen videos, half the bar — but an accident is not a rule, and a wrong
   * artist whose tracklist happens to fit would sail straight through it.
   */
  if (!result.artist.carried) {
    throw new MMError(
      "AWAITING_CONFIRM",
      `No candidate is credited to ${result.artist.wanted ?? "the artist this source names"}. ` +
        "Nothing was confirmed.",
      {
        hint:
          "MusicBrainz returned releases with this title by other artists. Read " +
          "`GET /api/v1/imports/{id}/candidates`, or pin one with `confirm-mapping`.",
        action: "Choose a release yourself",
        details: {
          importId: job.id,
          wantedArtist: result.artist.wanted,
          candidates: result.ranking.candidates.length,
        },
        status: 409,
      },
    );
  }

  /*
   * Only candidates whose tracklist was actually fetched can be chosen. The rest have a `fit`
   * of zero because nothing was looked up, not because they fit badly, and picking one would
   * mean confirming a release nobody has read the tracks of.
   */
  const ranked: RankedCandidate[] = candidates
    .filter((candidate) => candidate.detailed && candidate.fitLines.length > 0)
    .map((candidate) => {
      const mapped = candidate.fitLines.filter((line) => line.trackPosition !== null).length;
      return {
        candidate,
        mapped,
        coverage: mapped / rows.length,
        isAlbum: isAlbumType(candidate.type),
      };
    });

  const best = orderCandidates(ranked, preferType)[0];

  if (best === undefined) {
    throw new MMError(
      "AWAITING_CONFIRM",
      "No MusicBrainz release candidate has a tracklist to map this import against.",
      {
        hint: "Read `GET /api/v1/imports/{id}/candidates`, or confirm by hand with `confirm-mapping`.",
        action: "Choose a release yourself",
        details: { importId: job.id, videos: rows.length, candidates: ranked.length },
        status: 409,
      },
    );
  }

  const chosen: ChosenRelease = {
    kind: "release",
    mbid: best.candidate.id,
    title: best.candidate.title,
    artist: best.candidate.artist,
    year: best.candidate.year,
    primaryType: best.candidate.type,
    score: best.candidate.score,
    mapped: best.mapped,
    videos: rows.length,
    coverage: round3(best.coverage),
  };

  if (best.coverage < minCoverage) {
    throw new MMError(
      "AWAITING_CONFIRM",
      `The best candidate, “${chosen.title}” by ${chosen.artist}, maps ${String(best.mapped)} of ` +
        `${String(rows.length)} video(s) — ${String(Math.round(best.coverage * 100))} % coverage, ` +
        `under the ${String(Math.round(minCoverage * 100))} % this call asked for. ` +
        "Nothing was confirmed.",
      {
        hint:
          "The import is still waiting. Lower `minCoverage`, or read " +
          "`GET /api/v1/imports/{id}/candidates` and confirm a mapping yourself.",
        action: "Choose a release yourself",
        details: {
          importId: job.id,
          releaseMbid: chosen.mbid,
          title: chosen.title,
          artist: chosen.artist,
          primaryType: chosen.primaryType,
          coverage: chosen.coverage,
          mapped: best.mapped,
          videos: rows.length,
          minCoverage,
        },
        status: 409,
      },
    );
  }

  /*
   * **The engine may confirm alone only on an exact match**, and this is the place it confirms
   * alone.
   *
   * `docs/04` calls `confirm-best` "le seul chemin qui valide une release sans que personne ne
   * lise la fiche", and the MCP header one file over names the session it was written for: 375
   * playlists driven through this call by hand. Five of the fifteen albums the sixth owner
   * review flags — *Smoke + Mirrors* (21 videos), *Random Access Memories (Drumless)* (13),
   * *The Family Jewels* (13), *Night Candy* (4), *Ceremonials* (15) — have **no release of the
   * right size in MusicBrainz at all**, and one was chosen for each of them anyway.
   *
   * It is the generalisation of the artist refusal just above: the artist gate is one of the
   * four conditions `exactnessRefusal` checks, and the other three are the ones that would have
   * stopped those five. `minCoverage` is **not** a waiver and never was one — it is a bar the
   * caller may *raise*, and it only ever looked at one side of the fit: thirteen videos of
   * which twelve bind on a thirteen-track release is 92 % coverage and one track of the record
   * left silently empty. A caller that means "this inexact album, deliberately" has a door of
   * its own, and it is `confirm-mapping`.
   */
  const exact = exactnessRefusal({
    kind: "album",
    answered: false,
    // `confirm-best` is by definition about a MusicBrainz release: it has just ranked the
    // candidates and is about to commit one. "Import without MusicBrainz" is a different
    // request and has a different door — `confirm-mapping` with `releaseMbid: null`, or the
    // untagged fallback `match` applies to a folder on its own.
    untagged: false,
    videos: rows.length,
    bound: best.mapped,
    tracks: best.candidate.tracks,
    artistCarried: result.artist.carried,
  });
  if (exact !== null) {
    throw new MMError(
      "AWAITING_CONFIRM",
      `The best candidate, “${chosen.title}” by ${chosen.artist}, is not an exact match — ` +
        `${exact}. Nothing was confirmed.`,
      {
        hint:
          "The import is still waiting. Read `GET /api/v1/imports/{id}/candidates` and confirm " +
          "the mapping you want with `confirm-mapping`; `minCoverage` cannot waive this.",
        action: "Choose a release yourself",
        details: {
          importId: job.id,
          releaseMbid: chosen.mbid,
          title: chosen.title,
          artist: chosen.artist,
          videos: rows.length,
          mapped: best.mapped,
          tracks: best.candidate.tracks,
          why: exact,
        },
        status: 409,
      },
    );
  }

  /*
   * The mapping, straight off the candidate's own fit.
   *
   * `videoIndex` is `position` — the video's index in this source, which is what
   * `SuppliedMapping` and `confirm-mapping`'s `bindings[].position` both mean. Unbound lines are
   * dropped rather than sent with a null track: an omitted video is how a caller says "this one
   * is an extra", and `match` raises the `extra_videos` notice for it.
   */
  const mapping: SuppliedMapping = {
    releaseMbid: best.candidate.id,
    ...(best.candidate.releaseGroupId === null
      ? {}
      : { releaseGroupMbid: best.candidate.releaseGroupId }),
    ...(best.candidate.title === "" ? {} : { album: best.candidate.title }),
    ...(best.candidate.artist === "" ? {} : { albumArtist: best.candidate.artist }),
    year: best.candidate.year,
    trackTotal: best.candidate.tracks,
    tracks: best.candidate.fitLines.flatMap((line) =>
      line.trackPosition === null
        ? []
        : [
            {
              position: line.videoIndex,
              trackPosition: line.trackPosition,
              mediumPosition: line.mediumPosition ?? 1,
              recordingMbid: line.recordingMbid,
              trackTitle: line.trackTitle ?? "",
              confidence: 1,
              ...(line.trackMbid === null ? {} : { trackMbid: line.trackMbid }),
            },
          ],
    ),
  };

  return await applyAndReport(context, mapping, {
    kind: "album",
    chosen,
    minCoverage,
    preferType,
    minMargin: null,
    candidatesConsidered: ranked.length,
  });
}

/* ------------------------------------------------------------------ */
/* confirm-best: the single                                            */
/* ------------------------------------------------------------------ */

/**
 * The single branch: confirm the engine's preselected recording when it is decisive.
 *
 * The evidence is `judgeRecording`'s four conditions, and the mapping written from it is the
 * same one `match` would have written by itself (`matchOneRecording`): the recording, the borrow
 * release it is filed under, and that release's track position. Nothing is recomputed — the
 * borrow release is `chooseBorrowRelease`'s answer, carried on the candidate — so, exactly as on
 * the album path, the mapping cannot disagree with the score it was chosen on.
 *
 * A refusal is an `AWAITING_CONFIRM` 409 listing every condition that failed, because "too
 * close to call" and "that is a cover" want different things done about them and the caller
 * deserves to be told which one it is.
 */
async function confirmBestRecording(
  context: ConfirmContext,
  ranking: { readonly candidates: readonly RecordingCandidate[] },
): Promise<ConfirmBestResult> {
  const { job, rows, videos, settings, input } = context;
  const bar = recordingBarOf(settings, input.minMargin);

  const row = rows[0];
  const video = videos[0];
  if (row === undefined || video === undefined) {
    throw new MMError("INVALID_INPUT", "This import has no video to match.", { status: 400 });
  }

  const best = ranking.candidates[0];
  if (best === undefined) {
    throw new MMError(
      "AWAITING_CONFIRM",
      `MusicBrainz has no recording candidate for “${video.title}”.`,
      {
        hint: "Read `GET /api/v1/imports/{id}/candidates`, or confirm by hand with `confirm-mapping`.",
        action: "Choose a recording yourself",
        details: { importId: job.id, candidates: 0, minMargin: bar.minMargin },
        status: 409,
      },
    );
  }

  const verdict = judgeRecording(best, ranking.candidates[1], video, bar);
  const borrow = best.borrow;

  if (!verdict.ok || borrow === null) {
    throw new MMError(
      "AWAITING_CONFIRM",
      `The best recording, “${best.title}” by ${best.artist}, is not decisive: ` +
        `${verdict.failures.join("; ")}. Nothing was confirmed.`,
      {
        hint:
          "The import is still waiting. Lower `minMargin`, or read " +
          "`GET /api/v1/imports/{id}/candidates` and confirm a mapping yourself.",
        action: "Choose a recording yourself",
        details: {
          importId: job.id,
          recordingMbid: best.id,
          title: best.title,
          artist: best.artist,
          score: best.score,
          margin: verdict.margin,
          minMargin: bar.minMargin,
          durationDelta: verdict.durationDelta,
          durationToleranceSeconds: bar.durationToleranceSeconds,
          titleAgreement: verdict.titleAgreement,
          artistAgreement: verdict.artistAgreement,
          minAgreement: bar.minAgreement,
          failures: verdict.failures,
        },
        status: 409,
      },
    );
  }

  const trackPosition = borrow.trackPosition ?? 1;
  const chosen: ChosenRecording = {
    kind: "recording",
    mbid: best.id,
    title: best.title,
    artist: best.artist,
    score: best.score,
    length: best.length,
    margin: verdict.margin,
    durationDelta: verdict.durationDelta,
    titleAgreement: verdict.titleAgreement,
    artistAgreement: verdict.artistAgreement,
    releaseMbid: borrow.id,
    releaseTitle: borrow.title,
    releaseType: borrow.type,
    trackPosition,
  };

  /*
   * One line, for one video. `trackTotal` is deliberately **absent**, not `borrow.trackCount`:
   * supplying it would make `applySupplied` open an `uncovered_tracks` notice for the twelve
   * other tracks of the album this song is borrowing a home from, which is not a question about
   * this import — nobody asked to import the record.
   */
  const mapping: SuppliedMapping = {
    releaseMbid: borrow.id,
    ...(borrow.title === "" ? {} : { album: borrow.title }),
    ...(best.artist === "" ? {} : { albumArtist: best.artist }),
    year: borrow.date === null ? null : Number(borrow.date.slice(0, 4)),
    tracks: [
      {
        position: row.position,
        trackPosition,
        mediumPosition: 1,
        recordingMbid: best.id,
        trackTitle: best.title,
        confidence: best.score,
      },
    ],
  };

  return await applyAndReport(context, mapping, {
    kind: "single",
    chosen,
    minCoverage: null,
    preferType: null,
    minMargin: bar.minMargin,
    candidatesConsidered: ranking.candidates.length,
  });
}

/* ------------------------------------------------------------------ */
/* the half both branches share                                        */
/* ------------------------------------------------------------------ */

/**
 * Open the gate, apply the mapping, and report what `match` really did.
 *
 * Shared verbatim by both branches, which is the point: whatever decided the candidate, the
 * confirmation itself — the signature, the `match` run, the extras acknowledgement, the queue —
 * has to be the same act, or an audit of `decisions` would have to know which branch wrote a row.
 */
async function applyAndReport(
  context: ConfirmContext,
  mapping: SuppliedMapping,
  verdict: {
    kind: "album" | "single";
    chosen: ChosenCandidate;
    minCoverage: number | null;
    preferType: PreferType | null;
    minMargin: number | null;
    candidatesConsidered: number;
  },
): Promise<ConfirmBestResult> {
  const { job, settings, confirmedBy, db, input } = context;

  await setImportOptions(
    job.id,
    {
      mapping,
      releaseMbid: mapping.releaseMbid,
      // Supplying the mapping *is* the confirmation, exactly as on `confirm-mapping`. The
      // signature is what makes `confirm` write `decisions.decidedBy = confirmedBy` rather than
      // inferring a decider from the fact that the gate is open (`assertSigned`).
      autoConfirm: true,
      confirmedBy,
    },
    { releaseMbid: mapping.releaseMbid },
    db,
  );

  const applied = await runStep(job.id, "match", { db, settings });
  await acknowledgeExtras(job.id, db);

  const info = (applied.data ?? {}) as { mapped?: number; extras?: number };
  const open = await listInbox({ importId: job.id, status: "open" }, db);

  // Queue only when the mapping took. Queuing after a refused `match` asks the worker to carry
  // on from a mapping that was not applied.
  const queued = applied.status === "done" || applied.status === "skipped";
  if (queued) await enqueue(job.id, input.source ?? "api confirm-best");

  const fresh = (await getImport(job.id, db)) ?? job;

  return {
    importId: job.id,
    kind: verdict.kind,
    chosen: verdict.chosen,
    minCoverage: verdict.minCoverage,
    preferType: verdict.preferType,
    minMargin: verdict.minMargin,
    candidatesConsidered: verdict.candidatesConsidered,
    mapped: info.mapped ?? null,
    extras: info.extras ?? null,
    uncovered: open.filter((item) => item.type === "uncovered_tracks").length,
    queued,
    confirmedBy,
    status: fresh.status,
    step: fresh.step,
  };
}

/**
 * Close the `extra_videos` notices this confirmation has just answered.
 *
 * Same reasoning as `POST /imports/{id}/confirm-mapping`: a mapping that omits those videos *is*
 * the answer to "what about these?". `uncovered_tracks` is deliberately left open — the release
 * having tracks the source does not is a question about the album's completeness, and it belongs
 * in Review.
 */
async function acknowledgeExtras(importId: string, db: Database): Promise<void> {
  for (const item of await listInbox({ importId, status: "open" }, db)) {
    if (item.type !== "extra_videos") continue;
    await resolveInboxItem(
      item.id,
      {
        resolution: { action: "ignore", acknowledgedIn: "confirm-best" },
        decidedBy: "confirm-best",
      },
      db,
    );
  }
}
