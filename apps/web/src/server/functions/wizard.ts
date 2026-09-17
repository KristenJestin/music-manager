/**
 * The four steps of `/import/new`, as four server functions.
 *
 * The shape of the whole thing follows one decision: **nothing is committed until you press
 * Start.** Step 1 creates the import row, because `resolve` needs somewhere to put fifteen
 * videos and because whoever pasted the URL is watching; steps 2 and 3 compute against those
 * rows and write nothing at all; step 4 writes the answer as a *supplied mapping* — the escape
 * hatch `docs/04` already defines and P03 already tests — and hands the job to the worker.
 *
 * That is why the wizard does not simply run the `match` step and read its output: the step
 * decides, persists and raises Inbox items, and a wizard that did those things before you had
 * chosen anything would be asking you to confirm work it had already done.
 *
 * The one subtlety worth spelling out is `extra_videos`. `match` raises it for videos outside
 * the tracklist; step 3 shows those videos, in a table, before you press Start. Once you have
 * pressed Start, the question has been asked and answered, so the item is resolved here with
 * `decidedBy: "console"` rather than left in the Inbox for you to answer a second time.
 * `uncovered_tracks` is deliberately *not* treated that way: "this release has two tracks your
 * source does not" is a question about the album's completeness, and it belongs in Review.
 */
import { z } from "zod";
import { MMError } from "@mm/contracts";
import {
  albumHints,
  releaseGroups,
  type MappingLine,
  type MatchTrack,
  type RecordingCandidate,
  type ReleaseCandidate,
  type ReleaseGroupCandidate,
  type UncoveredTrack,
  type ExtraVideo,
} from "@mm/domain";
import { db } from "#/server/db/client.ts";
import type { Import, ImportKind, ImportTrack } from "#/server/db/schema/index.ts";
import { createServerFn } from "@tanstack/react-start";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { enqueue } from "#/server/services/queue.ts";
import { createFromUrl, getImport } from "#/server/services/imports.ts";
import { listInbox, resolveInboxItem } from "#/server/services/inbox.ts";
import { pauseImport, runStep } from "#/server/services/jobs/index.ts";
import type { SuppliedMapping } from "#/server/services/jobs/steps/match.ts";
import { duplicatesOf, setImportOptions } from "#/server/services/console.queries.ts";
import { youtubeThumbnail } from "#/server/services/documents.ts";
import {
  hintsFor,
  mappingFor,
  parseMbid,
  pinnedRecording,
  pinnedRelease,
  rankFor,
  searchRecordings,
  searchReleases,
  videosOf,
} from "#/server/services/matching.queries.ts";
import {
  matchRun,
  settleMatchRun,
  startMatchRun,
  takeMatchFailure,
} from "#/server/services/match-runs.ts";
import { loadSettings, type Settings } from "#/server/services/settings.ts";
import { isSourceOutage } from "#/lib/errors.ts";

/* ------------------------------------------------------------------ */
/* step 1 — the source                                                 */
/* ------------------------------------------------------------------ */

/** One row of "what yt-dlp sees". */
export interface SourceVideo {
  readonly id: string;
  readonly videoId: string;
  readonly index: number;
  readonly title: string;
  readonly durationSeconds: number | null;
  readonly uploader: string | null;
  readonly ytTrack: string | null;
  /** The best thumbnail yt-dlp reported for this video, or `null` when it kept none. */
  readonly thumbnail: string | null;
}

export interface SourceView {
  readonly importId: string;
  readonly url: string;
  readonly kind: ImportKind;
  readonly title: string | null;
  readonly uploader: string | null;
  readonly videos: readonly SourceVideo[];
  readonly totalSeconds: number;
  /**
   * What the source looks like: the first video's thumbnail.
   *
   * A YouTube-generated release playlist has no picture of its own — every entry carries the
   * same square cover as its frame — so the first one is the album's, and step 1 can show the
   * record rather than a letter on a gradient.
   */
  readonly thumbnail: string | null;
  /** What the YouTube tags and the description agree the album is. */
  readonly hints: {
    readonly album: string | null;
    readonly artist: string | null;
    readonly year: number | null;
    readonly label: string | null;
    readonly releasedOn: string | null;
  };
  /** The first video's auto-generated description, verbatim, for the highlighted panel. */
  readonly description: string | null;
  /** Imports of the same URL that already exist, newest first. */
  readonly duplicates: readonly { id: string; status: string; createdAt: string }[];
}

function toSourceView(
  job: Import,
  rows: readonly ImportTrack[],
  duplicates: readonly Import[],
): SourceView {
  const videos = rows.map((row) => {
    const raw = row.raw;
    const track = raw["track"];
    return {
      id: row.id,
      videoId: row.videoId,
      index: row.position,
      title: row.sourceTitle,
      durationSeconds: row.sourceDuration,
      uploader: row.uploader,
      ytTrack: typeof track === "string" ? track : null,
      thumbnail: youtubeThumbnail(raw as never),
    };
  });
  const matchVideos = rows.map((row) => ({
    id: row.videoId,
    index: row.position,
    title: row.sourceTitle,
    durationSeconds: row.sourceDuration,
    uploader: row.uploader,
    ytTrack: typeof row.raw["track"] === "string" ? (row.raw["track"] as string) : null,
    ytArtist: typeof row.raw["artist"] === "string" ? (row.raw["artist"] as string) : null,
    ytAlbum: typeof row.raw["album"] === "string" ? (row.raw["album"] as string) : null,
    ytReleaseYear:
      typeof row.raw["release_year"] === "number" ? (row.raw["release_year"] as number) : null,
    description:
      typeof row.raw["description"] === "string" ? (row.raw["description"] as string) : null,
  }));
  const hints = albumHints(matchVideos, {
    album: job.title,
    artist: job.artist,
    year: job.year,
  });
  const description = matchVideos.find((video) => video.description !== null)?.description ?? null;

  return {
    importId: job.id,
    url: job.url,
    kind: job.kind,
    title: job.title,
    uploader: job.artist,
    videos,
    totalSeconds: rows.reduce((sum, row) => sum + (row.sourceDuration ?? 0), 0),
    thumbnail: videos.find((video) => video.thumbnail !== null)?.thumbnail ?? null,
    hints: {
      album: hints.album ?? null,
      artist: hints.artist ?? null,
      year: hints.year ?? null,
      label: hints.label ?? null,
      releasedOn: hints.releasedOn ?? null,
    },
    description,
    duplicates: duplicates.map((row) => ({
      id: row.id,
      status: row.status,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

/**
 * Paste a URL, get a source.
 *
 * `createFromUrl` runs `resolve` in this process — that is P03's deliberate choice and the
 * reason the paste box answers in a second rather than after a worker poll.
 *
 * It then **parks the job**, and that is not optional. `createFromUrl` leaves the import in
 * `pending`/`running` at `match`, and a running worker's `resumableImports()` picks up exactly
 * those: without this, opening the wizard would start the import the wizard exists to let you
 * configure — the worker would match, auto-confirm and download while you were still looking
 * at step 1. `paused` is not resumable, so nothing touches the job until step 4 says so, and
 * a job abandoned half-way through the wizard stays abandoned instead of quietly importing
 * whatever the algorithm preferred.
 */
export const resolveSource = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ url: z.string().trim().min(1) }))
  .handler(async ({ data }): Promise<SourceView> => {
    try {
      const created = await createFromUrl(data.url, { db: db() });
      await pauseImport(created.job.id, "Waiting for the import wizard.", db());
      const { rows } = await videosOf(created.job.id, db());
      return toSourceView({ ...created.job, status: "paused" }, rows, created.duplicates);
    } catch (error) {
      return toFailure(error);
    }
  });

/** Re-read a source the wizard already resolved — a reload, or a step walked back to. */
export const fetchSource = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ importId: z.string().min(1) }))
  .handler(async ({ data }): Promise<SourceView> => {
    try {
      const job = await getImport(data.importId, db());
      if (job === null) {
        throw new MMError("NOT_FOUND", `No import with id ${data.importId}.`, { status: 404 });
      }
      const { rows } = await videosOf(job.id, db());
      // Asked again on every visit: the wizard redirects away from the URL it resolved, so the
      // answer `createFromUrl` gave is long gone by the time step 1 renders.
      const duplicates = await duplicatesOf(job.url, job.id, db());
      return toSourceView(job, rows, duplicates);
    } catch (error) {
      return toFailure(error);
    }
  });

/* ------------------------------------------------------------------ */
/* step 2 — the candidates                                             */
/* ------------------------------------------------------------------ */

export interface CandidatesView {
  readonly kind: "album" | "single";
  readonly releases: readonly ReleaseCandidate[];
  /**
   * The same releases, folded into their release groups (decision 151).
   *
   * Step 2 renders **this** on the album path; `releases` stays because the flat order is
   * what the API, the MCP tool and the single path already speak, and because a screen that
   * has both can show a group score next to a release score without recomputing either.
   */
  readonly groups: readonly ReleaseGroupCandidate[];
  readonly recordings: readonly RecordingCandidate[];
  readonly preselectedId: string | null;
  readonly safe: boolean;
  readonly ambiguous: boolean;
  readonly margin: number | null;
  readonly budget: { readonly searches: number; readonly lookups: number };
  /** The ceiling that budget was drawn from, so the screen can say "4 of 4" and mean it. */
  readonly planned: { readonly searches: number; readonly lookups: number };
  readonly queries: readonly string[];
  /** What the source thinks it is — shown above the list so the query is never a mystery. */
  readonly hints: { readonly album: string | null; readonly artist: string | null };
  /**
   * Set when MusicBrainz refused and this list came out of the raw cache instead.
   *
   * `null` on the normal path. When it is present the candidates are real but possibly stale,
   * and step 2 says so rather than pretending the source answered (decision 165).
   */
  readonly degraded: DegradedSource | null;
  /**
   * Set when MusicBrainz refused **and** the cache could not stand in for it.
   *
   * Reported as a value rather than raised as an exception, and that is the whole point: an
   * exception's shape depends on how it travelled. A loader that rejects during SSR has its
   * error inlined as `{name, message}` and loses everything else, so a step reading `status`
   * off it would say "MusicBrainz is unavailable" on a client navigation and "MusicBrainz is
   * unavailable (HTTP 503)" on a reload — the same failure, two sentences. JSON says the same
   * thing on every path (decision 165). The lists are empty when this is set.
   */
  readonly unavailable: DegradedSource | null;
  /**
   * The match is running **behind** this request, and there is nothing to show yet.
   *
   * Step 2 is fifteen seconds of MusicBrainz on the owner's settings, and those fifteen
   * seconds used to be spent inside this very handler — which is how a page ended up being
   * killed by a ten-second idle timeout and how a reload restarted the whole search
   * (`server/services/match-runs.ts`). The work now runs beside the request; this field is
   * the request saying so, and the screen follows `/api/match-progress` until it flips.
   *
   * A value rather than a 202 or an exception, for the reason the two fields above give: JSON
   * reads the same whether the loader ran during SSR or from a click, and a status code does
   * not survive the SSR boundary at all.
   *
   * The lists are empty when this is set, exactly as for `unavailable`.
   */
  readonly pending: boolean;
}

/** Why a view is not what a healthy source would have produced. */
export interface DegradedSource {
  readonly code: string;
  readonly message: string;
  readonly status: number | null;
  readonly hint: string | null;
}

/** A view with no candidates in it, which is two different sentences and one set of fields. */
function blankCandidates(
  job: Import,
  say: { unavailable: DegradedSource | null; pending: boolean },
): CandidatesView {
  return {
    kind: job.kind === "single" ? "single" : "album",
    releases: [],
    groups: [],
    recordings: [],
    preselectedId: null,
    safe: false,
    ambiguous: false,
    margin: null,
    budget: { searches: 0, lookups: 0 },
    planned: { searches: 0, lookups: 0 },
    queries: [],
    hints: { album: job.title, artist: job.artist },
    degraded: null,
    unavailable: say.unavailable,
    pending: say.pending,
  };
}

/** The view for "the source refused and the cache had nothing": no list, and why. */
function emptyCandidates(job: Import, unavailable: DegradedSource): CandidatesView {
  return blankCandidates(job, { unavailable, pending: false });
}

/** The view for "ask again in a second": no list, and a match running behind the request. */
function pendingCandidates(job: Import): CandidatesView {
  return blankCandidates(job, { unavailable: null, pending: true });
}

function degradedOf(error: unknown): DegradedSource {
  const failure = MMError.from(error);
  return {
    code: failure.code,
    message: failure.message,
    status: failure.status ?? null,
    hint: failure.hint ?? null,
  };
}

/** How many candidates the wizard shows. More is noise; the search box is for the rest. */
const SHOWN = 12;

/**
 * How many release groups the wizard shows.
 *
 * Fewer than `SHOWN`, on purpose: a group is a whole record, and a screen offering eight of
 * them is a screen nobody reads to the bottom. Three release searches can only produce three
 * groups plus whatever a hand search adds, so this is a ceiling that rarely binds.
 */
const SHOWN_GROUPS = 6;

/**
 * Turn a finished ranking into the screen's shape. The two kinds share every field but three.
 */
async function candidatesView(
  job: Import,
  result: Awaited<ReturnType<typeof rankFor>>,
  degraded: DegradedSource | null,
): Promise<CandidatesView> {
  const { videos } = await videosOf(job.id, db());
  const hints = hintsFor(job, videos);
  const preselected = result.ranking.preselected;
  const common = {
    preselectedId: preselected?.id ?? null,
    safe: preselected?.safe ?? false,
    ambiguous: result.ranking.ambiguous,
    margin: result.ranking.margin,
    budget: result.budget,
    planned: result.planned,
    queries: result.queries,
    hints: { album: hints.album ?? null, artist: hints.artist ?? null },
    degraded,
    unavailable: null,
    pending: false,
  } as const;

  if (result.kind === "single") {
    return {
      ...common,
      kind: "single",
      releases: [],
      groups: [],
      recordings: result.ranking.candidates.slice(0, SHOWN),
    };
  }
  return {
    ...common,
    kind: "album",
    releases: result.ranking.candidates.slice(0, SHOWN),
    groups: result.groups.groups.slice(0, SHOWN_GROUPS),
    recordings: [],
  };
}

/**
 * The ranking as it can be computed from `source_cache` alone, or `null` when it cannot.
 *
 * The rescue of decision 165 and **only** that: it runs after a live attempt has failed, never
 * before one. It is not a fast path and must not become one, for two reasons.
 *
 * First, it would not buy anything. `sourceTtlDays.musicbrainz` is thirty days, so a *live*
 * ranking of an import matched last week reads every document out of `source_cache` and makes
 * no request either — the cache is what makes a revisit instant, not the `offline` flag.
 *
 * Second, it would spend something. For a `fixture://` source the gateway is a cassette
 * whatever `offline` says, so an extra offline pass is an extra pass through the recorded
 * scenario — which is how `e2e/mb-outage.spec.ts` arms *two* refusals and expects to see the
 * "unavailable" screen rather than the degraded one.
 *
 * `null` rather than a throw, because "the cache cannot answer this" is a fact about the cache
 * and the caller has a sentence ready for it. A miss raises `OFFLINE_CACHE_MISS` from
 * `integrations/cached.ts`; anything *else* thrown here is a real bug and is left to escape.
 */
async function cachedView(job: Import, settings: Settings): Promise<CandidatesView | null> {
  try {
    const ranked = await rankFor({ job, settings, db: db(), offline: true });
    return await candidatesView(job, ranked, null);
  } catch (error) {
    if (MMError.from(error).code === "OFFLINE_CACHE_MISS") return null;
    if (isSourceOutage(error)) return null;
    throw error;
  }
}

/**
 * A run that failed, reported once — rescued by the cache when the cache can stand in.
 *
 * Decision 165, unchanged in substance: a list that might be a week old and *says so* beats no
 * list. What changed is where the failure comes from. It used to be the exception the handler
 * had just caught; it is now the one the background run recorded, read out of the registry and
 * erased on the way past so that Retry starts a fresh attempt.
 */
async function failedView(
  job: Import,
  settings: Settings,
  failure: unknown,
): Promise<CandidatesView> {
  const rescued = await cachedView(job, settings);
  const degraded = degradedOf(failure);
  return rescued === null ? emptyCandidates(job, degraded) : { ...rescued, degraded };
}

/**
 * How long the request lingers on a match it has just started, before answering "pending".
 *
 * Two seconds. A match answered from `source_cache` or from a `fixture://` cassette finishes in
 * milliseconds, and making *that* cost a second round trip and a flash of the waiting screen
 * would be a regression dressed up as a fix. A real MusicBrainz match cannot finish inside it —
 * ten to fourteen requests at one per second — so the slow case always gets the pending answer,
 * which is the case this whole change is about.
 *
 * Far below the connection's own patience, which is what the change exists to respect.
 */
const GRACE_MS = 2_000;

/**
 * Step 2's candidates, without waiting for MusicBrainz inside the request.
 *
 * **This handler no longer runs the match in its own HTTP request.** It used to, and that is
 * what the owner saw die: fourteen MusicBrainz requests at one per second, on a connection the
 * production runtime closes after ten seconds of silence (`server/http/abort.ts`). The four
 * states below replaced those fifteen seconds.
 *
 *  1. a match is **running** — say so and return; the screen follows `/api/match-progress`,
 *     and a reload lands here too, which is what makes a reload resume rather than restart;
 *  2. a match has **finished** — render the ranking it left in the registry, with no
 *     recomputation and no request;
 *  3. the last run **failed** — report it once, rescued by the cache where it can be
 *     (decision 165), and forget it so that Retry is a real retry;
 *  4. nothing is known — start a run, linger a moment in case it is instant, and otherwise
 *     answer "pending".
 *
 * Two things about the order.
 *
 * `running` is checked before anything else because a half-finished match has left half its
 * documents in `source_cache`, and a ranking computed from half the documents is a wrong answer
 * presented as a final one. While a run is in flight, the only honest answer is "in flight".
 *
 * And state 4 starts a **live** run rather than reaching for the cache first, which looks like
 * the slower choice and is not. `sourceTtlDays.musicbrainz` is thirty days, so a live ranking of
 * an import matched last week reads every document out of `source_cache` and finishes inside the
 * grace below without a single request — exactly like the old synchronous handler, which is also
 * why a Back to step 2 was never the slow case. The cache is the fast path; `offline` is the
 * rescue, and it stays where decision 165 put it.
 */
export const fetchCandidates = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ importId: z.string().min(1) }))
  .handler(async ({ data }): Promise<CandidatesView> => {
    try {
      const job = await getImport(data.importId, db());
      if (job === null) {
        throw new MMError("NOT_FOUND", `No import with id ${data.importId}.`, { status: 404 });
      }
      const settings = await loadSettings(db());
      const run = matchRun(job.id);

      // 1. In flight. A reload three seconds in joins it rather than starting a second one.
      if (run?.status === "running") return pendingCandidates(job);

      // 2. Finished, and the ranking is still in hand: no recomputation, no request, the exact
      //    answer the run produced. `result` is null only if the registry was swept mid-read.
      if (run?.status === "done" && run.result !== null) {
        return await candidatesView(job, run.result, null);
      }

      // 3. Failed. Read once — see `takeMatchFailure` — so Retry is a real retry.
      if (run?.status === "failed") {
        return await failedView(job, settings, takeMatchFailure(job.id));
      }

      // 4. Nothing known. Start the match behind the request, and linger only a moment for it:
      //    an import already in the cache finishes inside the grace and never shows a spinner.
      startMatchRun(job.id, () => rankFor({ job, settings, db: db() }));
      const settled = await settleMatchRun(job.id, GRACE_MS);
      if (settled?.status === "done" && settled.result !== null) {
        return await candidatesView(job, settled.result, null);
      }
      if (settled?.status === "failed") {
        return await failedView(job, settings, takeMatchFailure(job.id));
      }
      return pendingCandidates(job);
    } catch (error) {
      return toFailure(error);
    }
  });

/** What a manual search or a pasted MBID gives back, in either import kind. */
export interface SearchResultView {
  readonly kind: "album" | "single";
  readonly releases: readonly ReleaseCandidate[];
  readonly groups: readonly ReleaseGroupCandidate[];
  readonly recordings: readonly RecordingCandidate[];
  readonly query: string;
}

/**
 * Search MusicBrainz in words, or paste an MBID.
 *
 * One function for both because they are the same act — "the list is wrong, here is what I
 * mean" — and because an MBID pasted into the search box should just work rather than being a
 * different field you have to notice.
 *
 * It follows the import's **kind**, which it did not before: a single searched releases, and
 * step 2 of a single renders recordings, so the box and the paste field were two visible,
 * inert controls on exactly the screen where the matcher had just proposed the wrong thing
 * (DRIVE-1 §B2).
 */
export const searchCandidates = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ importId: z.string().min(1), query: z.string().trim().min(1) }))
  .handler(async ({ data }): Promise<SearchResultView> => {
    try {
      const job = await getImport(data.importId, db());
      if (job === null) {
        throw new MMError("NOT_FOUND", `No import with id ${data.importId}.`, { status: 404 });
      }
      const settings = await loadSettings(db());
      const mbid = parseMbid(data.query);

      if (await isSingle(job)) {
        if (mbid !== null) {
          const { candidate } = await pinnedRecording({
            job,
            settings,
            db: db(),
            recordingMbid: mbid,
          });
          return { kind: "single", releases: [], groups: [], recordings: [candidate], query: mbid };
        }
        const found = await searchRecordings({ job, settings, db: db(), query: data.query });
        return {
          kind: "single",
          releases: [],
          groups: [],
          recordings: found.candidates,
          query: found.query,
        };
      }

      if (mbid !== null) {
        const { candidate } = await pinnedRelease({ job, settings, db: db(), releaseMbid: mbid });
        return {
          kind: "album",
          releases: [candidate],
          groups: releaseGroups.group([candidate]).groups,
          recordings: [],
          query: mbid,
        };
      }
      const found = await searchReleases({ job, settings, db: db(), query: data.query });
      return {
        kind: "album",
        releases: found.candidates,
        groups: found.groups,
        recordings: [],
        query: found.query,
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * "Is this a single?", answered the same way the `match` step answers it.
 *
 * `kind` is what `resolve` decided, and a playlist that turned out to hold one video is a
 * single whatever the row says — `matchStep` has always used `kind === "single" || rows === 1`
 * and the wizard has to agree with it, or step 2 renders recordings while the search box
 * queries releases.
 */
async function isSingle(job: Import): Promise<boolean> {
  if (job.kind === "single") return true;
  const { rows } = await videosOf(job.id, db());
  return rows.length === 1;
}

/**
 * One recording, by MBID, scored against this import's video.
 *
 * Steps 3 and 4 of the single path read it from the URL rather than from step 2's ranking,
 * so a reload — or a recording that only ever came from the search box — still renders.
 */
export const fetchRecording = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ importId: z.string().min(1), recordingMbid: z.string().min(1) }))
  .handler(async ({ data }): Promise<RecordingViewPayload> => {
    try {
      const job = await getImport(data.importId, db());
      if (job === null) {
        throw new MMError("NOT_FOUND", `No import with id ${data.importId}.`, { status: 404 });
      }
      const settings = await loadSettings(db());
      const { candidate } = await pinnedRecording({
        job,
        settings,
        db: db(),
        recordingMbid: data.recordingMbid,
      });
      const { rows } = await videosOf(job.id, db());
      const video = toSourceView(job, rows, []).videos[0] ?? null;
      return { recording: candidate, video };
    } catch (error) {
      return toFailure(error);
    }
  });

/** Step 3 and step 4 of a single: one recording, one video, and the releases to file it under. */
export interface RecordingViewPayload {
  readonly recording: RecordingCandidate;
  readonly video: SourceVideo | null;
}

/* ------------------------------------------------------------------ */
/* step 3 — the mapping                                                */
/* ------------------------------------------------------------------ */

export interface MappingCandidateTrack {
  readonly absoluteIndex: number;
  readonly position: number;
  readonly mediumPosition: number;
  readonly title: string;
  readonly lengthSeconds: number | null;
  readonly trackMbid: string | null;
  readonly recordingMbid: string | null;
}

export interface MappingViewPayload {
  readonly releaseMbid: string;
  readonly releaseTitle: string;
  readonly releaseArtist: string;
  readonly releaseYear: number | null;
  readonly releaseGroupMbid: string | null;
  readonly tracks: readonly MappingCandidateTrack[];
  readonly lines: readonly MappingLine[];
  readonly extraVideos: readonly ExtraVideo[];
  readonly uncoveredTracks: readonly UncoveredTrack[];
  readonly bound: number;
  readonly fit: number;
  readonly fitOf: number;
  readonly meanAbsDelta: number | null;
  /** The videos, so the left column of the mapping table needs no second call. */
  readonly videos: readonly SourceVideo[];
}

function toCandidateTrack(track: MatchTrack): MappingCandidateTrack {
  return {
    absoluteIndex: track.absoluteIndex,
    position: track.position,
    mediumPosition: track.mediumPosition,
    title: track.title,
    lengthSeconds: track.lengthSeconds,
    trackMbid: track.trackMbid,
    recordingMbid: track.recordingMbid,
  };
}

export const fetchMapping = createServerFn({ method: "GET", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ importId: z.string().min(1), releaseMbid: z.string().min(1) }))
  .handler(async ({ data }): Promise<MappingViewPayload> => {
    try {
      const job = await getImport(data.importId, db());
      if (job === null) {
        throw new MMError("NOT_FOUND", `No import with id ${data.importId}.`, { status: 404 });
      }
      const settings = await loadSettings(db());
      const view = await mappingFor({
        job,
        settings,
        db: db(),
        releaseMbid: data.releaseMbid,
      });
      const { rows } = await videosOf(job.id, db());
      return {
        releaseMbid: view.releaseMbid,
        releaseTitle: view.releaseTitle,
        releaseArtist: view.releaseArtist,
        releaseYear: view.releaseYear,
        releaseGroupMbid: view.releaseGroupMbid,
        tracks: view.tracks.map(toCandidateTrack),
        lines: view.proposal.lines,
        extraVideos: view.proposal.extraVideos,
        uncoveredTracks: view.proposal.uncoveredTracks,
        bound: view.proposal.bound,
        fit: view.proposal.fit,
        fitOf: view.proposal.fitOf,
        meanAbsDelta: view.proposal.meanAbsDelta,
        videos: toSourceView(job, rows, []).videos,
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/* ------------------------------------------------------------------ */
/* step 4 — start                                                      */
/* ------------------------------------------------------------------ */

const startInput = z.object({
  importId: z.string().min(1),
  /**
   * `null` is **import without MusicBrainz** (P07a).
   *
   * P06 deferred this because an album with no release needed the library screens to be
   * findable and finishable; they exist now, so step 2 offers it for a source MusicBrainz
   * genuinely does not have. The document is then built from the YouTube tags alone and the
   * album carries an `untagged` badge with its own filter on `/library` and `/library/quality`.
   */
  releaseMbid: z.string().min(1).nullable(),
  releaseGroupMbid: z.string().nullable().default(null),
  album: z.string().default(""),
  albumArtist: z.string().default(""),
  year: z.number().int().nullable().default(null),
  trackTotal: z.number().int().min(0).default(0),
  /** One entry per bound video. A video absent from this list becomes an extra. */
  bindings: z
    .array(
      z.object({
        /** The video's index in the source listing. */
        position: z.number().int().min(0),
        trackPosition: z.number().int().min(1),
        mediumPosition: z.number().int().min(1).default(1),
        trackMbid: z.string().nullable().default(null),
        recordingMbid: z.string().min(1).nullable(),
        trackTitle: z.string().default(""),
        confidence: z.number().min(0).max(1).default(1),
      }),
    )
    .min(1),
  options: z
    .object({
      fingerprint: z.boolean().default(true),
      lyrics: z.boolean().default(true),
      replaygain: z.boolean().default(true),
      force: z.boolean().default(false),
    })
    .default({ fingerprint: true, lyrics: true, replaygain: true, force: false }),
  /** `low` | `normal` | `next` — the three chips of step 4. */
  priority: z.enum(["low", "normal", "next"]).default("normal"),
});

const PRIORITY: Record<"low" | "normal" | "next", number> = { low: -10, normal: 0, next: 100 };

export interface StartResult {
  readonly importId: string;
  readonly mapped: number;
  readonly extras: number;
  readonly uncovered: number;
  readonly status: string;
}

/**
 * Commit the wizard and hand the job to the worker.
 *
 * `match` is run here, synchronously, rather than left to the worker: it is the step that
 * applies the supplied mapping, it costs nothing (there is no MusicBrainz call left to make),
 * and running it now is what lets this function report "14 mapped, 1 extra" back to the page
 * that asked — and lets it resolve the `extra_videos` notice, which only exists once the step
 * has run. Everything after `match` is queued, as it must be: a download inside an HTTP
 * request dies with the request.
 */
export const startImport = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(startInput)
  .handler(async ({ data }): Promise<StartResult> => {
    try {
      const job = await getImport(data.importId, db());
      if (job === null) {
        throw new MMError("NOT_FOUND", `No import with id ${data.importId}.`, { status: 404 });
      }

      const mapping: SuppliedMapping = {
        releaseMbid: data.releaseMbid,
        releaseGroupMbid: data.releaseGroupMbid,
        ...(data.album === "" ? {} : { album: data.album }),
        ...(data.albumArtist === "" ? {} : { albumArtist: data.albumArtist }),
        year: data.year,
        trackTotal: data.trackTotal,
        // `SuppliedMapping` says "absent", the wire says "null"; they mean the same thing and
        // only one of them survives `exactOptionalPropertyTypes`.
        tracks: data.bindings.map((binding) => ({
          position: binding.position,
          trackPosition: binding.trackPosition,
          mediumPosition: binding.mediumPosition,
          recordingMbid: binding.recordingMbid,
          trackTitle: binding.trackTitle,
          confidence: binding.confidence,
          ...(binding.trackMbid === null ? {} : { trackMbid: binding.trackMbid }),
        })),
      };

      await setImportOptions(
        data.importId,
        {
          mapping,
          releaseMbid: data.releaseMbid,
          fingerprint: data.options.fingerprint,
          lyrics: data.options.lyrics,
          replaygain: data.options.replaygain,
          force: data.options.force,
          // The wizard *is* the confirmation gate of `docs/04`: you have just seen the
          // release, the mapping and the options and pressed Start. Blocking on `confirm`
          // afterwards would be asking the same question twice.
          autoConfirm: true,
          confirmedBy: "console",
        },
        { priority: PRIORITY[data.priority], releaseMbid: data.releaseMbid },
        db(),
      );

      const settings = await loadSettings(db());
      const result = await runStep(data.importId, "match", { db: db(), settings });

      // Videos outside the tracklist were shown in step 3 and accepted by pressing Start.
      await acknowledgeExtras(data.importId);

      const after = await getImport(data.importId, db());
      await enqueue(data.importId, "console wizard");

      const info = (result.data ?? {}) as { mapped?: number; extras?: number };
      const uncovered = (await listInbox({ importId: data.importId, status: "open" }, db())).filter(
        (item) => item.type === "uncovered_tracks",
      ).length;

      return {
        importId: data.importId,
        mapped: info.mapped ?? data.bindings.length,
        extras: info.extras ?? 0,
        uncovered,
        status: after?.status ?? "pending",
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/** Close the `extra_videos` notices of an import, recording who answered and how. */
async function acknowledgeExtras(importId: string): Promise<void> {
  const open = await listInbox({ importId, status: "open" }, db());
  for (const item of open) {
    if (item.type !== "extra_videos") continue;
    await resolveInboxItem(
      item.id,
      {
        resolution: { action: "ignore", acknowledgedIn: "import wizard" },
        decidedBy: "console",
      },
      db(),
    );
  }
}
