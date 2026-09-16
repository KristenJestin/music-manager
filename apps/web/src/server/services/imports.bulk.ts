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
 */
import { MMError, type MMErrorBody } from "@mm/contracts";
import type { ReleaseCandidate } from "@mm/domain";
import { db as defaultDb, type Database } from "#/server/db/client.ts";
import { createFromUrl, getImport } from "#/server/services/imports.ts";
import { setImportOptions } from "#/server/services/console.queries.ts";
import { listInbox, resolveInboxItem } from "#/server/services/inbox.ts";
import { rankFor, videosOf } from "#/server/services/matching.queries.ts";
import { runStep } from "#/server/services/jobs/index.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import { enqueue, enqueueMany } from "#/server/services/queue.ts";
import type { SuppliedMapping } from "#/server/services/jobs/steps/match.ts";

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
  /** Earlier imports of the same URL. Reported, never a refusal — see `createFromUrl`. */
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
      const outcome = await createFromUrl(url, {
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
  readonly minCoverage?: number;
  readonly preferType?: PreferType;
  /** Who is confirming. Written to `decisions.decidedBy`; `assertSigned` requires it. */
  readonly confirmedBy: string;
  readonly db?: Database;
  readonly settings?: Settings;
  readonly source?: string;
}

/** What was chosen, and on what evidence. */
export interface ChosenCandidate {
  readonly releaseMbid: string;
  readonly title: string;
  readonly artist: string;
  readonly year: number | null;
  /** The release group's `primary-type` — `Album`, `EP`, `Single`… `null` when unknown. */
  readonly primaryType: string | null;
  readonly score: number;
  /** Videos this candidate binds to a track of its tracklist. */
  readonly mapped: number;
  /** Videos in the import, mapped or not — the denominator of `coverage`. */
  readonly videos: number;
  readonly coverage: number;
}

export interface ConfirmBestResult {
  readonly importId: string;
  readonly chosen: ChosenCandidate;
  readonly minCoverage: number;
  readonly preferType: PreferType;
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
 * Pick the candidate that maps the most tracks, and confirm it — or refuse and change nothing.
 *
 * The mapping is `fitLines`, filtered to the bound lines and renamed into `SuppliedMapping`'s
 * vocabulary. No arithmetic, no matching, no second opinion: the engine already decided which
 * video is which track when it scored this candidate, and re-deriving that here is precisely the
 * work this function exists to stop a client doing.
 *
 * When nothing clears `minCoverage` it throws `AWAITING_CONFIRM` — a 409 — naming the best
 * candidate and the coverage it reached, and the import is left exactly as it was, waiting. That
 * is the point of the bar: a batch of three hundred may confirm two hundred and ninety of itself
 * and leave ten for a human, and the ten have to still be there afterwards.
 */
export async function confirmBest(input: ConfirmBestInput): Promise<ConfirmBestResult> {
  const db = input.db ?? defaultDb();
  const minCoverage = input.minCoverage ?? DEFAULT_MIN_COVERAGE;
  const preferType = input.preferType ?? "album";
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

  const { rows } = await videosOf(job.id, db);
  if (rows.length === 0) {
    throw new MMError("INVALID_INPUT", "This import has no videos yet, so nothing can be mapped.", {
      hint: "The `resolve` step has produced no listing. Read `GET /api/v1/imports/{id}`.",
      status: 400,
    });
  }

  const settings = input.settings ?? (await loadSettings(db));
  const result = await rankFor({ job, settings, db });

  if (result.kind !== "album") {
    /*
     * A single has no tracklist to cover, so "coverage" would be 1 whatever was chosen and the
     * bar would mean nothing. Refusing by name is better than confirming on a number that
     * cannot fail.
     */
    throw new MMError(
      "INVALID_INPUT",
      "This import is a single; `confirm-best` chooses between release candidates.",
      {
        hint: "Read `GET /api/v1/imports/{id}/candidates` and use `confirm-mapping`.",
        details: { kind: result.kind },
        status: 400,
      },
    );
  }

  /*
   * Only candidates whose tracklist was actually fetched can be chosen. The rest have a `fit`
   * of zero because nothing was looked up, not because they fit badly, and picking one would
   * mean confirming a release nobody has read the tracks of.
   */
  const ranked: RankedCandidate[] = result.ranking.candidates
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

  const chosen: ChosenCandidate = {
    releaseMbid: best.candidate.id,
    title: best.candidate.title,
    artist: best.candidate.artist,
    year: best.candidate.year,
    primaryType: best.candidate.type,
    score: best.candidate.score,
    mapped: best.mapped,
    videos: rows.length,
    coverage: Math.round(best.coverage * 1000) / 1000,
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
          releaseMbid: chosen.releaseMbid,
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

  await setImportOptions(
    job.id,
    {
      mapping,
      releaseMbid: best.candidate.id,
      // Supplying the mapping *is* the confirmation, exactly as on `confirm-mapping`. The
      // signature is what makes `confirm` write `decisions.decidedBy = confirmedBy` rather than
      // inferring a decider from the fact that the gate is open (`assertSigned`).
      autoConfirm: true,
      confirmedBy,
    },
    { releaseMbid: best.candidate.id },
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
    chosen,
    minCoverage,
    preferType,
    candidatesConsidered: ranked.length,
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
