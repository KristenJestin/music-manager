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
 * pressed Start, the question has been asked and answered, so the item is resolved by
 * `services/confirm.ts` with `decidedBy: "console"` rather than left in the Inbox for you to
 * answer a second time.
 * `uncovered_tracks` is deliberately *not* treated that way: "this release has two tracks your
 * source does not" is a question about the album's completeness, and it belongs in Review.
 */
import { z } from "zod";
import { MMError } from "@mm/contracts";
import {
  albumHints,
  releaseGroups,
  type DiscMode,
  type MappingLine,
  type MatchTrack,
  type RecordingCandidate,
  type ReleaseCandidate,
  type ReleaseGroupCandidate,
  type SanitizeMode,
  type UncoveredTrack,
  type ExtraVideo,
} from "@mm/domain";
import { db } from "#/server/db/client.ts";
import type { Import, ImportKind, ImportTrack } from "#/server/db/schema/index.ts";
import { createServerFn } from "@tanstack/react-start";
import { STRICT, sessionMiddleware, toFailure } from "#/server/functions/base.ts";
import { createImport, getImport } from "#/server/services/imports.ts";
import { pauseImport, runStep } from "#/server/services/jobs/index.ts";
import { videoRows, type SuppliedMapping } from "#/server/services/jobs/steps/match.ts";
import { duplicatesOf } from "#/server/services/console.queries.ts";
import { confirmSupplied } from "#/server/services/confirm.ts";
import { resolveMbRef, type ResolveInput, type ResolvedRef } from "#/server/services/mb-resolve.ts";
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
  /**
   * The entries the source listed and `resolve` could not read — usually empty.
   *
   * `videos.length + unreadable.length` is what the playlist claimed to hold, which is what
   * step 4 says out loud before Start. It exists because the wizard's own count is otherwise
   * indistinguishable from a complete album: the owner would have pressed Start on nineteen
   * tracks believing there were nineteen.
   */
  readonly unreadable: readonly {
    readonly position: number | null;
    readonly videoId: string | null;
    readonly reason: string | null;
    readonly code: string;
  }[];
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
  /** When this import was opened. Step 1 names it when it re-entered an existing one. */
  readonly createdAt: string;
  /**
   * This call re-entered an import that already existed instead of opening a new one.
   *
   * Only `resolveSource` can answer it — `fetchSource` is a read and reuses nothing — and the
   * wizard carries it into the address bar as `?reused`, because the loader redirects to
   * `?importId=` and the answer would otherwise be lost between the two screens.
   */
  readonly reused: boolean;
}

function toSourceView(
  job: Import,
  allRows: readonly ImportTrack[],
  duplicates: readonly Import[],
  reused = false,
): SourceView {
  /*
   * The wizard shows **the source**, so it shows the rows that came from it.
   *
   * A `sourceless` row is a track of the release that the source never published
   * (`services/sourceless.ts`); it has no video id, no thumbnail and no yt-dlp entry, and it
   * is created at confirmation — after this screen. It cannot appear here on a first pass, but
   * it can on a second (a re-match sends an already-confirmed import back through), and
   * listing it as a video of the source would be a plain falsehood: it would be counted in
   * "19 videos", offered for mapping, and fed to `albumHints` as a title with no uploader.
   */
  const rows = videoRows(allRows);
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
    unreadable: job.unreadable.map((gap) => ({
      position: gap.position,
      videoId: gap.id,
      reason: gap.reason,
      code: gap.code,
    })),
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
    createdAt: job.createdAt.toISOString(),
    reused,
  };
}

/**
 * Paste a URL, get a source.
 *
 * `createImport` runs `resolve` in this process — that is P03's deliberate choice and the
 * reason the paste box answers in a second rather than after a worker poll.
 *
 * It then **parks the job**, and that is not optional. `createImport` leaves the import in
 * `pending`/`running` at `match`, and a running worker's `resumableImports()` picks up exactly
 * those: without this, opening the wizard would start the import the wizard exists to let you
 * configure — the worker would match, auto-confirm and download while you were still looking
 * at step 1. `paused` is not resumable, so nothing touches the job until step 4 says so, and
 * a job abandoned half-way through the wizard stays abandoned instead of quietly importing
 * whatever the algorithm preferred.
 */
export const resolveSource = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      url: z.string().trim().min(1),
      /**
       * The release this import is pinned to, chosen **before** the URL was known.
       *
       * That is the command palette's order of events: you paste a MusicBrainz release, ⌘K
       * offers "start an import pinned to this", and the URL is the thing still missing. It is
       * the same door the CLI's `--release` uses — `imports.options.releaseMbid`, which
       * `match` honours by looking the release up by MBID rather than by taking the
       * preselection. Nothing new decides anything.
       */
      releaseMbid: z.string().trim().min(1).max(64).optional(),
      /**
       * Open a **new** import even though this URL already has one that could be re-entered.
       *
       * The escape hatch, and it has to be asked for. Re-importing a URL is legitimate — it is
       * how you pick up better metadata — but it is a decision, and making it the default is
       * what left 204 parked imports for 7 URLs on the owner's instance, each one a yt-dlp
       * extraction nobody wanted.
       */
      fresh: z.boolean().optional(),
    }),
  )
  .handler(async ({ data }): Promise<SourceView> => {
    try {
      const created = await createImport(data.url, {
        db: db(),
        reuse: data.fresh !== true,
        ...(data.releaseMbid === undefined ? {} : { releaseMbid: data.releaseMbid }),
      });
      await parkForWizard(created.job.id);
      const { rows } = await videosOf(created.job.id, db());
      return toSourceView(
        { ...created.job, status: "paused" },
        rows,
        created.duplicates,
        created.reused,
      );
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Park a job where the wizard can work on it, and keep it parked between visits.
 *
 * Not optional and not cosmetic: `createImport` leaves an import `pending` at `match`, and a
 * running worker's `resumableImports()` picks exactly those up. Without this, opening the
 * wizard would start the import the wizard exists to let you configure.
 *
 * `paused` is not resumable, so nothing touches the job until step 4 says so — and because
 * every entrance goes through here, an import re-entered on a second visit is re-parked rather
 * than left in whatever state the previous visit abandoned it in.
 */
async function parkForWizard(importId: string): Promise<void> {
  await pauseImport(importId, "Waiting for the import wizard.", db());
}

/**
 * "Re-fetch" — ask the source again, on the import already open.
 *
 * It used to be the same call as "Resolve", which meant the button labelled *re-fetch* created
 * a sibling import every time it was pressed. It now re-runs the `resolve` step on the row the
 * wizard is looking at. `resolve` is idempotent by construction (see its own note): the entries
 * are re-read and the raw payloads replaced, and nothing a later step wrote is disturbed,
 * because those columns are matched on the entry id rather than on the row.
 *
 * Refused on an import that is running or finished. There is no honest way to re-read the
 * source under a download that is in flight, and a `done` import is a record of what happened
 * rather than a draft — "import it again" is a new import, made deliberately.
 */
export const refetchSource = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ importId: z.string().min(1) }))
  .handler(async ({ data }): Promise<SourceView> => {
    try {
      const job = await getImport(data.importId, db());
      if (job === null) {
        throw new MMError("NOT_FOUND", `No import with id ${data.importId}.`, { status: 404 });
      }
      if (job.status === "running" || job.status === "done" || job.status === "cancelled") {
        throw new MMError(
          "INVALID_INPUT",
          `This import is ${job.status}, so its source cannot be read again into it.`,
          {
            hint:
              job.status === "running"
                ? "It is on the worker now. Pause it first, or watch it on its job page."
                : "Paste the URL again to open a new import; the duplicate is reported, not refused.",
            action: "Open a new import",
            status: 409,
          },
        );
      }

      const result = await runStep(job.id, "resolve", {
        db: db(),
        settings: await loadSettings(db()),
      });
      /*
       * A re-fetch that failed is raised here rather than filed away.
       *
       * The job row keeps the typed error, as it always does — but whoever pressed the button
       * is still looking at the screen, and parking the import on top of a failed `resolve`
       * would leave a row that says `paused` over a step that says it could not read the
       * source. The wizard's own error banner is the right place for it.
       */
      if (result.status === "failed" && result.error !== undefined) {
        throw MMError.fromBody(result.error);
      }
      // `resolve` leaves the job `pending` at `match`, which a running worker would pick up.
      await parkForWizard(job.id);

      const fresh = (await getImport(job.id, db())) ?? job;
      const { rows } = await videosOf(job.id, db());
      const duplicates = await duplicatesOf(fresh.url, fresh.id, db());
      return toSourceView({ ...fresh, status: "paused" }, rows, duplicates);
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
      // answer `createImport` gave is long gone by the time step 1 renders.
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
   * Enough of the placement settings to **compute** where a file will land.
   *
   * The single path asks you to pick which release supplies the album context — the folder,
   * the `ALBUM` tag and the track number — and it used to describe that in a sentence. A
   * sentence about a path is not a path: choosing between two albums should show two different
   * paths. `renderPathTemplate` is pure and in `@mm/domain`, so the wizard renders exactly what
   * `place` will, from the settings that will be in force.
   */
  readonly filing: {
    readonly template: string;
    readonly discMode: DiscMode;
    readonly sanitize: SanitizeMode;
    /** The container the download will produce, so the preview ends in the right suffix. */
    readonly extension: string;
  };
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

/**
 * The placement settings the wizard renders a path preview from.
 *
 * Opus is the extension, because it is what the downloader produces for a YouTube source and
 * what `place` will therefore be filing; the preview would be a lie in any other suffix.
 */
function filingOf(settings: Settings): CandidatesView["filing"] {
  return {
    template: settings.pathTemplate,
    discMode: settings.discMode,
    sanitize: settings.sanitizeMode,
    extension: "opus",
  };
}

/**
 * A view with no candidates in it, which is two different sentences and one set of fields.
 *
 * `filing` travels even here, and not because a blank screen has a path to preview. It is a
 * property of the *settings* rather than of the candidate list, so there is no view of this
 * import for which the answer is unknown; making it optional on two of the four states would
 * push a `?? null` into every reader for a case that cannot arise.
 */
function blankCandidates(
  job: Import,
  say: {
    unavailable: DegradedSource | null;
    pending: boolean;
    filing: CandidatesView["filing"];
  },
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
    filing: say.filing,
    degraded: null,
    unavailable: say.unavailable,
    pending: say.pending,
  };
}

/** The view for "the source refused and the cache had nothing": no list, and why. */
function emptyCandidates(
  job: Import,
  unavailable: DegradedSource,
  filing: CandidatesView["filing"],
): CandidatesView {
  return blankCandidates(job, { unavailable, pending: false, filing });
}

/** The view for "ask again in a second": no list, and a match running behind the request. */
function pendingCandidates(job: Import, filing: CandidatesView["filing"]): CandidatesView {
  return blankCandidates(job, { unavailable: null, pending: true, filing });
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
  filing: CandidatesView["filing"],
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
    filing,
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
  const shown = result.ranking.candidates.slice(0, SHOWN);
  const releases = await withPinned(job, shown);
  return {
    ...common,
    // A pin is a decision already taken, so it wins over what the matcher preferred. It is the
    // same rule `match` applies to `options.releaseMbid` (`jobs/steps/match.ts`): falling back
    // to the preselection would silently import a different record from the one asked for.
    preselectedId: pinOf(job) ?? common.preselectedId,
    kind: "album",
    releases,
    /*
     * The groups come from the ranking, as they always have — regrouping the twelve shown
     * would silently change what "12 releases" on a card counts. The one exception is a pin
     * the search never returned: it is not in the ranking, so it is not in any group either,
     * and step 2 draws groups. Regrouping then is what puts a card under the selection.
     */
    groups:
      releases === shown
        ? result.groups.groups.slice(0, SHOWN_GROUPS)
        : releaseGroups.group(releases).groups.slice(0, SHOWN_GROUPS),
    recordings: [],
  };
}

/** The release this import was pinned to before it had a source, or `null`. */
function pinOf(job: Import): string | null {
  const pinned = job.options.releaseMbid;
  return pinned === undefined || pinned === "" ? null : pinned;
}

/**
 * The pinned release, in the list, whether or not the search found it.
 *
 * A pin the search never returned is the case that matters — it is exactly why somebody
 * reached for it. Step 2 would otherwise open on a highlighted id with no card under it, which
 * reads as "nothing was chosen". `pinnedRelease` is the wizard's existing escape hatch: one
 * lookup by MBID, scored by the same engine as every other candidate, so the number on the
 * pinned card means what the numbers beside it mean.
 *
 * A failure here is not fatal. The pin still travels to `match` in `options.releaseMbid`, so
 * losing the *card* costs a picture and not the decision.
 */
async function withPinned(
  job: Import,
  candidates: readonly ReleaseCandidate[],
): Promise<readonly ReleaseCandidate[]> {
  const pinned = pinOf(job);
  if (pinned === null) return candidates;
  if (candidates.some((candidate) => candidate.id === pinned)) return candidates;
  try {
    const settings = await loadSettings(db());
    const { candidate } = await pinnedRelease({ job, settings, db: db(), releaseMbid: pinned });
    return [candidate, ...candidates].slice(0, SHOWN);
  } catch {
    return candidates;
  }
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
    return await candidatesView(job, ranked, null, filingOf(settings));
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
  return rescued === null
    ? emptyCandidates(job, degraded, filingOf(settings))
    : { ...rescued, degraded };
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
 *
 * `MM_MATCH_GRACE_MS` overrides it, and `0` is the useful value: it makes *every* match answer
 * `pending` on the first request, whatever it was going to cost. That is how
 * `e2e/wizard-matching.spec.ts` reaches the waiting screen at all — offline, the cassette
 * answers in milliseconds, so the slow path would never otherwise be drawn in a test.
 *
 * Read once, at module load, and clamped rather than trusted: a bad value in `.env` must not
 * become a request that waits for ever.
 */
const GRACE_MS = ((): number => {
  const raw = Number.parseInt((process.env["MM_MATCH_GRACE_MS"] ?? "").trim(), 10);
  return Number.isFinite(raw) && raw >= 0 && raw <= 10_000 ? raw : 2_000;
})();

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
      if (run?.status === "running") return pendingCandidates(job, filingOf(settings));

      // 2. Finished, and the ranking is still in hand: no recomputation, no request, the exact
      //    answer the run produced. `result` is null only if the registry was swept mid-read.
      if (run?.status === "done" && run.result !== null) {
        return await candidatesView(job, run.result, null, filingOf(settings));
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
        return await candidatesView(job, settled.result, null, filingOf(settings));
      }
      if (settled?.status === "failed") {
        return await failedView(job, settings, takeMatchFailure(job.id));
      }
      return pendingCandidates(job, filingOf(settings));
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
  /** The Lucene query as it left, verbatim. */
  readonly query: string;
  /**
   * The title and artist it was built from.
   *
   * Sent back so an empty result can **read back what was searched for**. "Nothing found for
   * that" is useless; "nothing titled *bewitched Laufey*" would have told the owner instantly
   * that his artist name had been folded into the title, which is exactly what had happened.
   * It also makes a guessed split visible, and therefore correctable.
   */
  readonly terms: { title: string; artist: string | null; guessed: boolean } | null;
}

/**
 * What is this id? — asked the moment the box holds one, not when a button is pressed.
 *
 * The box had two failure modes and this answers both. It **refused the id people have**: a
 * release id pasted on a single came back as "No MusicBrainz recording with id …", which says
 * the id is wrong when it is the *kind* that is wrong. And it **said nothing for the id it
 * accepted**: a valid recording id produced no error, no preview and no new candidate, so the
 * owner's question was, verbatim, "does that mean it found it and I can hit next???" — and the
 * answer was no, he had to press Search MusicBrainz, and nothing said so.
 *
 * So the resolution is a *read*: one gated lookup, no writes, no side effects, called as the
 * field changes. `null` means the string holds no MusicBrainz reference at all, which is the
 * page's signal that this is free text and belongs in a search.
 *
 * It stays inside its own request, where `fetchCandidates` above no longer does. Five lookups
 * is the ceiling and only an id that names nothing reaches it — a pasted *address* claims its
 * entity, so the ordinary case is one — which is five seconds against MusicBrainz's one request
 * a second, comfortably inside the 240 s idle timeout `server/http/abort.ts` now sets. And it
 * writes nothing: there is no half-finished state for a background run to protect, and a reload
 * that loses the answer simply asks the question again.
 */
export const resolvePastedRef = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ importId: z.string().min(1), input: z.string().min(1).max(500) }))
  .handler(async ({ data }): Promise<ResolvedRef | null> => {
    try {
      const job = await requireJob(data.importId);
      return await resolveMbRef(data.input, await refContext(job));
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Do what the preview said would happen.
 *
 * Every branch here is an existing pipeline path, reached with an id the resolver worked out:
 * `pinnedRecording` for a recording (and for the track a pasted *release* turned out to name),
 * `pinnedRelease` for a release, and the ordinary search for the two cases that are a search —
 * a release group's editions, and an artist's catalogue. Nothing new decides anything.
 *
 * `selectId` is the whole reason this is not `searchCandidates`: the caller has to know which
 * card to select, promote and scroll to. A hand-supplied candidate used to be appended to the
 * bottom of the list, below four irrelevant ones and off screen, and the owner reasonably
 * concluded that nothing had happened.
 */
export const applyPastedRef = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(z.object({ importId: z.string().min(1), input: z.string().min(1).max(500) }))
  .handler(async ({ data }): Promise<{ view: SearchResultView; selectId: string | null }> => {
    try {
      const job = await requireJob(data.importId);
      const context = await refContext(job);
      const ref = await resolveMbRef(data.input, context);
      if (ref === null) {
        throw new MMError("INVALID_INPUT", "That is not a MusicBrainz id or address.", {
          hint: "Paste an id, a musicbrainz.org link, or search in words.",
          status: 400,
        });
      }
      if (ref.action === "none" || ref.targetMbid === null) {
        // The refusal *names what it is*, which is the entire complaint: "no recording with id
        // X" for a perfectly good release is the worst answer available.
        throw new MMError("INVALID_INPUT", ref.explanation, {
          hint:
            ref.entity === null
              ? "Check the id on musicbrainz.org."
              : `The id is a valid ${ref.noun ?? "entity"}; this import needs something else.`,
          status: 400,
        });
      }

      const settings = await loadSettings(db());
      const single = context.single;

      if (ref.action === "use-recording" || ref.action === "track-of-release") {
        const { candidate } = await pinnedRecording({
          job,
          settings,
          db: db(),
          recordingMbid: ref.targetMbid,
        });
        return {
          view: {
            kind: "single",
            releases: [],
            groups: [],
            recordings: [candidate],
            query: ref.mbid,
            terms: null,
          },
          selectId: candidate.id,
        };
      }

      if (ref.action === "pin-release") {
        const { candidate } = await pinnedRelease({
          job,
          settings,
          db: db(),
          releaseMbid: ref.targetMbid,
        });
        return {
          view: {
            kind: "album",
            releases: [candidate],
            groups: releaseGroups.group([candidate]).groups,
            recordings: [],
            query: ref.mbid,
            terms: null,
          },
          selectId: candidate.id,
        };
      }

      /*
       * `editions-of-group` and `search-artist`: both are a search, run against the pipeline's
       * own scorer so a hand-found candidate's number means what every other number means.
       *
       * They differ in *which field* the text belongs in, and putting an artist's name in the
       * title field was the same bug as `bewitched Laufey`: pasting an artist id asked
       * MusicBrainz for a release literally titled "Daft Punk". An artist id is now the
       * artist-only search it always meant.
       */
      const text = ref.searchText ?? ref.title ?? ref.mbid;
      const artistOnly = ref.action === "search-artist";
      const query = artistOnly ? "" : text;
      const artist = artistOnly ? text : null;
      if (single) {
        const found = await searchRecordings({ job, settings, db: db(), query, artist });
        return {
          view: {
            kind: "single",
            releases: [],
            groups: [],
            recordings: found.candidates,
            query: found.query,
            terms: found.terms,
          },
          selectId: found.candidates[0]?.id ?? null,
        };
      }
      const found = await searchReleases({ job, settings, db: db(), query, artist });
      return {
        view: {
          kind: "album",
          releases: found.candidates,
          groups: found.groups,
          recordings: [],
          query: found.query,
          terms: found.terms,
        },
        selectId: found.candidates[0]?.id ?? null,
      };
    } catch (error) {
      return toFailure(error);
    }
  });

/**
 * Search MusicBrainz in words, or paste an MBID.
 *
 * One function for both because they are the same act — "the list is wrong, here is what I
 * mean" — and because an MBID pasted into the search box should just work rather than being a
 * different field you have to notice.
 *
 * **Either field alone is a search.** A title with no artist always was; an artist with no
 * title was not, and typing one produced nothing at all — which is precisely what somebody who
 * knows the band and not the exact album title has to type. It now searches that artist's
 * release groups (or, on a single, their recordings), and the empty-result message names what
 * was searched either way.
 *
 * It follows the import's **kind**, which it did not before: a single searched releases, and
 * step 2 of a single renders recordings, so the box and the paste field were two visible,
 * inert controls on exactly the screen where the matcher had just proposed the wrong thing
 * (DRIVE-1 §B2).
 */
export const searchCandidates = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z
      .object({
        importId: z.string().min(1),
        /**
         * The title — **or nothing at all**, when an artist is given.
         *
         * An artist on its own is a search: "I know the band, not which record", which is the
         * thing somebody does before they can type a title. The refinement below is what makes
         * it legal, and it is the *only* thing that had to change on this side; the Lucene
         * builder already drops an empty clause.
         */
        query: z.string().trim().default(""),
        /** The wizard's second field. Absent means "split the query and say what you split". */
        artist: z.string().trim().optional(),
      })
      .refine((data) => data.query !== "" || (data.artist ?? "") !== "", {
        message: "Give a title, an artist, or both.",
        path: ["query"],
      }),
  )
  .handler(async ({ data }): Promise<SearchResultView> => {
    try {
      const job = await requireJob(data.importId);
      const settings = await loadSettings(db());
      const artist = data.artist ?? null;
      const mbid = parseMbid(data.query);

      if (await isSingle(job)) {
        if (mbid !== null) {
          const { candidate } = await pinnedRecording({
            job,
            settings,
            db: db(),
            recordingMbid: mbid,
          });
          return {
            kind: "single",
            releases: [],
            groups: [],
            recordings: [candidate],
            query: mbid,
            terms: null,
          };
        }
        const found = await searchRecordings({
          job,
          settings,
          db: db(),
          query: data.query,
          artist,
        });
        return {
          kind: "single",
          releases: [],
          groups: [],
          recordings: found.candidates,
          query: found.query,
          terms: found.terms,
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
          terms: null,
        };
      }
      const found = await searchReleases({ job, settings, db: db(), query: data.query, artist });
      return {
        kind: "album",
        releases: found.candidates,
        groups: found.groups,
        recordings: [],
        query: found.query,
        terms: found.terms,
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

/** The import, or a 404 that says which id was asked for. */
async function requireJob(importId: string): Promise<Import> {
  const job = await getImport(importId, db());
  if (job === null) {
    throw new MMError("NOT_FOUND", `No import with id ${importId}.`, { status: 404 });
  }
  return job;
}

/**
 * What the resolver needs to know about this import: is it one video, and which one.
 *
 * The video's title and length are what turn "that is a release" into "that is a release, and
 * of its twelve tracks this is the one your video is" — the last step the owner should not
 * have to take by hand after pasting the album he already had.
 */
async function refContext(job: Import): Promise<ResolveInput> {
  const { videos } = await videosOf(job.id, db());
  const first = videos[0];
  return {
    job,
    single: await isSingle(job),
    videoTitle: first?.title ?? job.title ?? null,
    videoSeconds: first?.durationSeconds ?? null,
    db: db(),
  };
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

      // `services/confirm.ts` — the same function `POST /api/v1/imports/{id}/confirm-mapping`
      // calls. The wizard *is* the confirmation gate of `docs/04`: you have just seen the
      // release, the mapping and the options and pressed Start, so `autoConfirm` is opened and
      // signed `console` rather than asking the same question twice.
      const outcome = await confirmSupplied(
        {
          importId: data.importId,
          confirmedBy: "console",
          mapping,
          options: data.options,
          priority: PRIORITY[data.priority],
          acknowledgedIn: "import wizard",
          reason: "console wizard",
        },
        db(),
      );

      return {
        importId: data.importId,
        mapped: outcome.mapped,
        extras: outcome.extras,
        uncovered: outcome.uncovered,
        status: outcome.job.status,
      };
    } catch (error) {
      return toFailure(error);
    }
  });
