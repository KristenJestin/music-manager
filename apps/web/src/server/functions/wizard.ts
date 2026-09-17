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
import { createFromUrl, getImport } from "#/server/services/imports.ts";
import { pauseImport } from "#/server/services/jobs/index.ts";
import type { SuppliedMapping } from "#/server/services/jobs/steps/match.ts";
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
}

/** Why a view is not what a healthy source would have produced. */
export interface DegradedSource {
  readonly code: string;
  readonly message: string;
  readonly status: number | null;
  readonly hint: string | null;
}

/** The view for "the source refused and the cache had nothing": no list, and why. */
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

function emptyCandidates(
  job: Import,
  unavailable: DegradedSource,
  filing: CandidatesView["filing"],
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
    filing,
    degraded: null,
    unavailable,
  };
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

      /*
       * MusicBrainz refusing is not the end of step 2 (decision 165).
       *
       * The first attempt is the live one. If the source is down or rate-limiting us, the
       * ranking is computed a second time **offline**, against the raw cache: for an import
       * whose candidates were already fetched once — a reload, a Back, a second look — every
       * document it needs is a row, and the screen keeps its list instead of going blank. The
       * failure travels with it in `degraded`, because a list that might be a week old and
       * says nothing about it is worse than no list.
       *
       * When the cache has nothing either, the original *source* error is what is raised, not
       * `OFFLINE_CACHE_MISS`: "MusicBrainz answered HTTP 503" is the true cause, and the
       * second attempt is an implementation detail of trying to survive it.
       */
      let degraded: DegradedSource | null = null;
      let result: Awaited<ReturnType<typeof rankFor>>;
      try {
        result = await rankFor({ job, settings, db: db() });
      } catch (error) {
        if (!isSourceOutage(error)) throw error;
        try {
          result = await rankFor({ job, settings, db: db(), offline: true });
          degraded = degradedOf(error);
        } catch {
          // Neither the source nor the cache. The *source* error is what is reported —
          // "musicbrainz answered HTTP 503" is the cause; `OFFLINE_CACHE_MISS` is only how
          // the rescue attempt ended.
          return emptyCandidates(job, degradedOf(error), filingOf(settings));
        }
      }

      const { videos } = await videosOf(job.id, db());
      const hints = hintsFor(job, videos);

      if (result.kind === "single") {
        const preselected = result.ranking.preselected;
        return {
          kind: "single",
          releases: [],
          groups: [],
          recordings: result.ranking.candidates.slice(0, SHOWN),
          preselectedId: preselected?.id ?? null,
          safe: preselected?.safe ?? false,
          ambiguous: result.ranking.ambiguous,
          margin: result.ranking.margin,
          budget: result.budget,
          planned: result.planned,
          queries: result.queries,
          hints: { album: hints.album ?? null, artist: hints.artist ?? null },
          filing: filingOf(settings),
          degraded,
          unavailable: null,
        };
      }
      const preselected = result.ranking.preselected;
      return {
        kind: "album",
        releases: result.ranking.candidates.slice(0, SHOWN),
        groups: result.groups.groups.slice(0, SHOWN_GROUPS),
        recordings: [],
        preselectedId: preselected?.id ?? null,
        safe: preselected?.safe ?? false,
        ambiguous: result.ranking.ambiguous,
        margin: result.ranking.margin,
        budget: result.budget,
        planned: result.planned,
        queries: result.queries,
        hints: { album: hints.album ?? null, artist: hints.artist ?? null },
        filing: filingOf(settings),
        degraded,
        unavailable: null,
      };
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

      // `editions-of-group` and `search-artist`: both are a search, run against the pipeline's
      // own scorer so a hand-found candidate's number means what every other number means.
      const query = ref.searchText ?? ref.title ?? ref.mbid;
      if (single) {
        const found = await searchRecordings({ job, settings, db: db(), query });
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
      const found = await searchReleases({ job, settings, db: db(), query });
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
 * It follows the import's **kind**, which it did not before: a single searched releases, and
 * step 2 of a single renders recordings, so the box and the paste field were two visible,
 * inert controls on exactly the screen where the matcher had just proposed the wrong thing
 * (DRIVE-1 §B2).
 */
export const searchCandidates = createServerFn({ method: "POST", strict: STRICT })
  .middleware([sessionMiddleware])
  .inputValidator(
    z.object({
      importId: z.string().min(1),
      query: z.string().trim().min(1),
      /** The wizard's second field. Absent means "split the query and say what you split". */
      artist: z.string().trim().optional(),
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
